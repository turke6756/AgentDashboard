import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { fromArrayBuffer, GeoTIFFImage } from 'geotiff';
import { fetchFileBuffer } from './geo/geoUtils';
import { LoadingState, ErrorState, Stat } from './ShapefileRenderer';

interface Props {
  filePath: string;
}

interface Meta {
  width: number;
  height: number;
  bands: number;
  dtype: string;
  bbox: number[] | null;
  epsg: number | null;
  noData: number | null;
}

const COLORMAPS: Record<string, (t: number) => [number, number, number]> = {
  viridis: (t) => viridis(t),
  greys: (t) => [t * 255, t * 255, t * 255],
  magma: (t) => magma(t),
  inferno: (t) => inferno(t),
};

const MIN_SCALE = 0.02;
const MAX_SCALE = 64;

export default function GeoTiffRenderer({ filePath }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [colormap, setColormap] = useState<keyof typeof COLORMAPS>('viridis');
  const [rgbMode, setRgbMode] = useState(true);
  const [stretch, setStretch] = useState<'minmax' | 'percentile'>('percentile');
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragStartRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const rawRef = useRef<{ image: GeoTIFFImage; data: any; bands: number; width: number; height: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setError(null);
    rawRef.current = null;

    (async () => {
      try {
        const buf = await fetchFileBuffer(filePath);
        const tiff = await fromArrayBuffer(buf);
        const image = await tiff.getImage();
        const width = image.getWidth();
        const height = image.getHeight();
        const bands = image.getSamplesPerPixel();
        const dtype = String((image as any).getSampleFormat?.() || (image.getBitsPerSample() as any)?.[0] || 'unknown');

        let bbox: number[] | null = null;
        try { bbox = image.getBoundingBox(); } catch {}
        const gk = image.getGeoKeys() as any;
        const epsg: number | null = gk?.ProjectedCSTypeGeoKey || gk?.GeographicTypeGeoKey || null;
        const noDataStr = (image.getFileDirectory() as any)?.GDAL_NODATA;
        const noData = noDataStr ? parseFloat(String(noDataStr)) : null;

        // Downsample very large rasters for preview
        const MAX_PREVIEW = 2048;
        const scale = Math.min(1, MAX_PREVIEW / Math.max(width, height));
        const outW = Math.max(1, Math.round(width * scale));
        const outH = Math.max(1, Math.round(height * scale));
        const data = await image.readRasters({ width: outW, height: outH, interleave: false });

        if (cancelled) return;

        rawRef.current = {
          image,
          data,
          bands,
          width: outW,
          height: outH,
        };

        setMeta({ width, height, bands, dtype, bbox, epsg, noData });
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();

    return () => { cancelled = true; };
  }, [filePath]);

  // Render pixel data to canvas whenever meta or style changes
  useEffect(() => {
    const raw = rawRef.current;
    const canvas = canvasRef.current;
    if (!raw || !canvas || !meta) return;

    const { data, bands, width, height } = raw;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imgData = ctx.createImageData(width, height);

    const useRgb = rgbMode && bands >= 3;

    if (useRgb) {
      const r = data[0] as ArrayLike<number>;
      const g = data[1] as ArrayLike<number>;
      const b = data[2] as ArrayLike<number>;
      const a = bands >= 4 ? (data[3] as ArrayLike<number>) : null;

      const [rmin, rmax] = getRange(r, stretch);
      const [gmin, gmax] = getRange(g, stretch);
      const [bmin, bmax] = getRange(b, stretch);
      const nd = meta.noData;

      const total = width * height;
      for (let i = 0; i < total; i++) {
        const rv = r[i], gv = g[i], bv = b[i];
        const o = i * 4;
        if (nd !== null && (rv === nd || gv === nd || bv === nd)) {
          imgData.data[o + 3] = 0;
          continue;
        }
        imgData.data[o] = norm8(rv, rmin, rmax);
        imgData.data[o + 1] = norm8(gv, gmin, gmax);
        imgData.data[o + 2] = norm8(bv, bmin, bmax);
        imgData.data[o + 3] = a ? clamp255(a[i]) : 255;
      }
    } else {
      const band = data[0] as ArrayLike<number>;
      const [vmin, vmax] = getRange(band, stretch);
      const cmap = COLORMAPS[colormap];
      const nd = meta.noData;
      const total = width * height;
      for (let i = 0; i < total; i++) {
        const v = band[i];
        const o = i * 4;
        if (nd !== null && v === nd) {
          imgData.data[o + 3] = 0;
          continue;
        }
        if (!isFinite(v as number)) {
          imgData.data[o + 3] = 0;
          continue;
        }
        const t = vmax === vmin ? 0 : Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin)));
        const [cr, cg, cb] = cmap(t);
        imgData.data[o] = cr;
        imgData.data[o + 1] = cg;
        imgData.data[o + 2] = cb;
        imgData.data[o + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }, [meta, colormap, rgbMode, stretch]);

  const fitToViewport = useCallback(() => {
    const vp = viewportRef.current;
    const canvas = canvasRef.current;
    if (!vp || !canvas || !canvas.width || !canvas.height) return;
    const pad = 16;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const s = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, Math.min((vw - pad * 2) / canvas.width, (vh - pad * 2) / canvas.height)),
    );
    setView({ scale: s, x: (vw - canvas.width * s) / 2, y: (vh - canvas.height * s) / 2 });
  }, []);

  // Fit on first successful load
  useEffect(() => {
    if (meta) requestAnimationFrame(fitToViewport);
  }, [meta, fitToViewport]);

  // Wheel zoom (attach as non-passive so preventDefault works)
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const cur = viewRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cur.scale * factor));
      const ratio = next / cur.scale;
      setView({
        scale: next,
        x: cx - (cx - cur.x) * ratio,
        y: cy - (cy - cur.y) * ratio,
      });
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragging(true);
    dragStartRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = dragStartRef.current;
    if (!s) return;
    setView((v) => ({ ...v, x: s.x + (e.clientX - s.px), y: s.y + (e.clientY - s.py) }));
  };
  const endDrag = () => {
    setDragging(false);
    dragStartRef.current = null;
  };

  const zoomAt = (vpPoint: { x: number; y: number } | null, factor: number) => {
    const vp = viewportRef.current;
    const cur = viewRef.current;
    const p = vpPoint ?? (vp ? { x: vp.clientWidth / 2, y: vp.clientHeight / 2 } : { x: 0, y: 0 });
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cur.scale * factor));
    const ratio = next / cur.scale;
    setView({ scale: next, x: p.x - (p.x - cur.x) * ratio, y: p.y - (p.y - cur.y) * ratio });
  };

  if (error) return <ErrorState message={error} />;
  if (!meta) return <LoadingState label="Reading GeoTIFF…" />;

  const canRgb = meta.bands >= 3;
  const showCmapControl = !rgbMode || !canRgb;

  return (
    <div className="flex flex-col h-full bg-[#0a0a0f]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-surface-3 bg-surface-1 text-[11px] font-sans text-gray-400 shrink-0">
        <div className="flex items-center gap-4 flex-wrap">
          <Stat label="Size" value={`${meta.width.toLocaleString()} × ${meta.height.toLocaleString()}`} />
          <Stat label="Bands" value={String(meta.bands)} />
          {meta.epsg && <Stat label="EPSG" value={String(meta.epsg)} />}
          {meta.noData !== null && <Stat label="NoData" value={String(meta.noData)} />}
          {meta.bbox && <Stat label="BBox" value={meta.bbox.map((n) => n.toFixed(3)).join(', ')} />}
        </div>
        <div className="flex items-center gap-2">
          {canRgb && (
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rgbMode}
                onChange={(e) => setRgbMode(e.target.checked)}
                className="accent-accent-blue"
              />
              RGB
            </label>
          )}
          {showCmapControl && (
            <select
              value={colormap}
              onChange={(e) => setColormap(e.target.value as keyof typeof COLORMAPS)}
              className="bg-surface-2 text-gray-200 border border-surface-3 rounded px-1 py-0.5 text-[11px] font-sans"
            >
              {Object.keys(COLORMAPS).map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          )}
          <select
            value={stretch}
            onChange={(e) => setStretch(e.target.value as any)}
            className="bg-surface-2 text-gray-200 border border-surface-3 rounded px-1 py-0.5 text-[11px] font-sans"
            title="Contrast stretch"
          >
            <option value="percentile">2–98% stretch</option>
            <option value="minmax">Min/max</option>
          </select>
          <div className="flex items-center gap-1 border border-surface-3 rounded overflow-hidden">
            <button
              onClick={() => zoomAt(null, 1 / 1.25)}
              className="px-1.5 py-0.5 text-gray-300 hover:bg-surface-2"
              title="Zoom out"
            >
              <Icons.Minus className="w-3 h-3" />
            </button>
            <span className="px-1.5 py-0.5 text-gray-400 tabular-nums min-w-[3.5ch] text-center">
              {Math.round(view.scale * 100)}%
            </span>
            <button
              onClick={() => zoomAt(null, 1.25)}
              className="px-1.5 py-0.5 text-gray-300 hover:bg-surface-2"
              title="Zoom in"
            >
              <Icons.Plus className="w-3 h-3" />
            </button>
            <button
              onClick={fitToViewport}
              className="px-1.5 py-0.5 text-gray-300 hover:bg-surface-2 border-l border-surface-3"
              title="Fit to viewport"
            >
              <Icons.Maximize2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      <div
        ref={viewportRef}
        className="flex-1 min-h-0 relative overflow-hidden select-none"
        style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fitToViewport}
      >
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: '0 0',
            imageRendering: 'pixelated',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.1)',
          }}
        />
      </div>
    </div>
  );
}

function getRange(arr: ArrayLike<number>, mode: 'minmax' | 'percentile'): [number, number] {
  const n = arr.length;
  if (mode === 'minmax' || n < 100) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (!isFinite(v as number)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    return [min, max];
  }
  // Sample ~20k values, compute p2/p98
  const sampleStep = Math.max(1, Math.floor(n / 20000));
  const samples: number[] = [];
  for (let i = 0; i < n; i += sampleStep) {
    const v = arr[i];
    if (isFinite(v as number)) samples.push(v as number);
  }
  samples.sort((a, b) => a - b);
  if (samples.length === 0) return [0, 1];
  const lo = samples[Math.floor(samples.length * 0.02)];
  const hi = samples[Math.floor(samples.length * 0.98)];
  if (lo === hi) return [samples[0], samples[samples.length - 1]];
  return [lo, hi];
}

function norm8(v: number, min: number, max: number): number {
  if (!isFinite(v)) return 0;
  if (max <= min) return 0;
  const t = (v - min) / (max - min);
  return Math.max(0, Math.min(255, Math.round(t * 255)));
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// Compact 5-stop colormap samplers
function lerp3(stops: [number, number, number][], t: number): [number, number, number] {
  const n = stops.length - 1;
  const pos = t * n;
  const i = Math.floor(pos);
  const f = pos - i;
  const a = stops[Math.max(0, Math.min(n, i))];
  const b = stops[Math.max(0, Math.min(n, i + 1))];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}
function viridis(t: number): [number, number, number] {
  return lerp3(
    [
      [68, 1, 84],
      [59, 82, 139],
      [33, 145, 140],
      [94, 201, 98],
      [253, 231, 37],
    ],
    t,
  );
}
function magma(t: number): [number, number, number] {
  return lerp3(
    [
      [0, 0, 4],
      [80, 18, 123],
      [182, 54, 121],
      [251, 136, 97],
      [252, 253, 191],
    ],
    t,
  );
}
function inferno(t: number): [number, number, number] {
  return lerp3(
    [
      [0, 0, 4],
      [87, 15, 109],
      [187, 55, 84],
      [249, 142, 9],
      [252, 255, 164],
    ],
    t,
  );
}
