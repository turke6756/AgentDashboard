import React, { useEffect, useState } from 'react';
import * as Icons from 'lucide-react';
import { parseShp, parseDbf, combine } from 'shpjs';
import { fetchFileBuffer, fetchFileText, siblingPath, reprojectGeoJsonInPlace, parseWktToProj4Name } from './geo/geoUtils';
import GeoMap from './geo/GeoMap';
import AttributeTable from './geo/AttributeTable';

interface Props {
  filePath: string;
}

interface Loaded {
  geojson: any;
  rows: Record<string, any>[];
  crsName: string | null;
  featureCount: number;
  geomType: string | null;
}

export default function ShapefileRenderer({ filePath }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState<'map' | 'table' | 'split'>('split');

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);

    (async () => {
      try {
        const shpBuf = await fetchFileBuffer(filePath);
        const dbfBuf = await fetchFileBuffer(siblingPath(filePath, '.dbf')).catch(() => null);
        const prjText = await fetchFileText(siblingPath(filePath, '.prj'));
        const cpgText = await fetchFileText(siblingPath(filePath, '.cpg'));

        const crsName = prjText ? parseWktToProj4Name(prjText) : null;

        const geom = parseShp(shpBuf, prjText ?? undefined);
        let geojson: any;
        if (dbfBuf) {
          const attrs = parseDbf(dbfBuf, (cpgText || undefined) as any);
          geojson = combine([geom, attrs]);
        } else {
          geojson = {
            type: 'FeatureCollection',
            features: (geom as any[]).map((g: any) => ({ type: 'Feature', geometry: g, properties: {} })),
          };
        }

        if (crsName) reprojectGeoJsonInPlace(geojson, crsName);

        (geojson.features || []).forEach((f: any, i: number) => (f._idx = i));
        const rows = (geojson.features || []).map((f: any) => f.properties || {});
        const geomType = geojson.features?.[0]?.geometry?.type ?? null;

        if (!cancelled) {
          setLoaded({
            geojson,
            rows,
            crsName,
            featureCount: geojson.features?.length ?? 0,
            geomType,
          });
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (error) {
    return <ErrorState message={error} />;
  }
  if (!loaded) {
    return <LoadingState label="Reading shapefile…" />;
  }

  return (
    <div className="flex flex-col h-full">
      <Toolbar
        leftInfo={
          <>
            <Stat label="Features" value={loaded.featureCount.toLocaleString()} />
            <Stat label="Geom" value={loaded.geomType ?? '—'} />
            <Stat label="CRS" value={loaded.crsName ?? 'unknown'} />
          </>
        }
        view={view}
        onViewChange={setView}
      />
      <div className="flex-1 min-h-0 flex">
        {(view === 'map' || view === 'split') && (
          <GeoMap
            geojson={loaded.geojson}
            highlightIndex={hover}
            className={`h-full ${view === 'split' ? 'w-1/2 border-r border-surface-3' : 'w-full'}`}
          />
        )}
        {(view === 'table' || view === 'split') && (
          <div className={`h-full ${view === 'split' ? 'w-1/2' : 'w-full'}`}>
            <AttributeTable
              rows={loaded.rows}
              highlightIndex={hover}
              onRowHover={setHover}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function Toolbar({
  leftInfo,
  view,
  onViewChange,
  extra,
}: {
  leftInfo: React.ReactNode;
  view: 'map' | 'table' | 'split';
  onViewChange: (v: 'map' | 'table' | 'split') => void;
  extra?: React.ReactNode;
}) {
  const btn = (v: 'map' | 'table' | 'split', label: string, I: any) => (
    <button
      onClick={() => onViewChange(v)}
      className={`flex items-center gap-1 px-2 py-1 text-[11px] font-sans transition-colors ${
        view === v ? 'bg-accent-blue/30 text-gray-100' : 'text-gray-300 hover:bg-surface-2'
      }`}
    >
      <I className="w-3 h-3" /> {label}
    </button>
  );
  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-surface-3 bg-surface-1 text-[11px] font-sans text-gray-400 shrink-0">
      <div className="flex items-center gap-4">{leftInfo}</div>
      <div className="flex items-center gap-2">
        {extra}
        <div className="flex items-center gap-1 border border-surface-3 rounded overflow-hidden">
          {btn('map', 'Map', Icons.Map)}
          {btn('split', 'Split', Icons.Columns)}
          {btn('table', 'Table', Icons.Table)}
        </div>
      </div>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-gray-500">{label}:</span> <span className="text-gray-300">{value}</span>
    </span>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="flex items-center gap-3 text-gray-400">
        <Icons.Loader2 className="w-5 h-5 animate-spin" />
        <span className="font-sans text-sm">{label}</span>
      </div>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center p-8 max-w-md">
        <Icons.FileWarning className="w-10 h-10 text-accent-red mx-auto mb-4" />
        <div className="text-gray-300 font-sans text-sm mb-2">Failed to read geospatial file</div>
        <div className="text-gray-400 font-sans text-[12px] break-all">{message}</div>
      </div>
    </div>
  );
}
