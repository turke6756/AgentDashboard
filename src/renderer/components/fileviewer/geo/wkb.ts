// Minimal WKB → GeoJSON geometry decoder.
// Supports Point, LineString, Polygon, MultiPoint, MultiLineString,
// MultiPolygon, GeometryCollection. Handles 2D/3D/XYM/XYZM by reading
// and discarding extra ordinates.

type Geometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPoint'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }
  | { type: 'GeometryCollection'; geometries: Geometry[] };

class Reader {
  view: DataView;
  offset: number;
  littleEndian: boolean;
  constructor(view: DataView, offset = 0) {
    this.view = view;
    this.offset = offset;
    this.littleEndian = true;
  }
  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.offset, this.littleEndian);
    this.offset += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.offset, this.littleEndian);
    this.offset += 8;
    return v;
  }
}

function readGeometry(r: Reader): Geometry {
  r.littleEndian = r.u8() === 1;
  const rawType = r.u32();
  // Handle both EWKB (high-bit flags) and ISO WKB (thousands flags)
  const hasZ = !!(rawType & 0x80000000) || (rawType >= 1000 && rawType < 2000) || rawType >= 3000;
  const hasM = !!(rawType & 0x40000000) || (rawType >= 2000 && rawType < 3000) || rawType >= 3000;
  const hasSRID = !!(rawType & 0x20000000);
  const baseType = rawType & 0xff; // low byte covers both EWKB and ISO main types
  if (hasSRID) r.u32(); // consume SRID, ignore

  const readPoint = (): number[] => {
    const x = r.f64();
    const y = r.f64();
    const pt = [x, y];
    if (hasZ) pt.push(r.f64());
    if (hasM) {
      const m = r.f64();
      if (!hasZ) pt.push(m); // keep ordering 2D + m just collapses to [x,y,m] — rare
    }
    return pt;
  };

  const readRing = (): number[][] => {
    const n = r.u32();
    const ring: number[][] = [];
    for (let i = 0; i < n; i++) ring.push(readPoint());
    return ring;
  };

  switch (baseType) {
    case 1:
      return { type: 'Point', coordinates: readPoint() };
    case 2: {
      const n = r.u32();
      const coords: number[][] = [];
      for (let i = 0; i < n; i++) coords.push(readPoint());
      return { type: 'LineString', coordinates: coords };
    }
    case 3: {
      const nRings = r.u32();
      const rings: number[][][] = [];
      for (let i = 0; i < nRings; i++) rings.push(readRing());
      return { type: 'Polygon', coordinates: rings };
    }
    case 4: {
      const n = r.u32();
      const pts: number[][] = [];
      for (let i = 0; i < n; i++) {
        const g = readGeometry(r);
        if (g.type === 'Point') pts.push((g as any).coordinates);
      }
      return { type: 'MultiPoint', coordinates: pts };
    }
    case 5: {
      const n = r.u32();
      const lines: number[][][] = [];
      for (let i = 0; i < n; i++) {
        const g = readGeometry(r);
        if (g.type === 'LineString') lines.push((g as any).coordinates);
      }
      return { type: 'MultiLineString', coordinates: lines };
    }
    case 6: {
      const n = r.u32();
      const polys: number[][][][] = [];
      for (let i = 0; i < n; i++) {
        const g = readGeometry(r);
        if (g.type === 'Polygon') polys.push((g as any).coordinates);
      }
      return { type: 'MultiPolygon', coordinates: polys };
    }
    case 7: {
      const n = r.u32();
      const parts: Geometry[] = [];
      for (let i = 0; i < n; i++) parts.push(readGeometry(r));
      return { type: 'GeometryCollection', geometries: parts };
    }
    default:
      throw new Error(`Unsupported WKB geometry type: ${baseType} (raw ${rawType})`);
  }
}

export function decodeGeoPackageGeometry(blob: Uint8Array): Geometry | null {
  if (!blob || blob.length < 8) return null;
  // Magic 'GP'
  if (blob[0] !== 0x47 || blob[1] !== 0x50) return null;
  // version = blob[2]
  const flags = blob[3];
  const envelopeKind = (flags >> 1) & 0x07;
  let headerLen = 8;
  const envSizes = [0, 32, 48, 48, 64, 0, 0, 0];
  headerLen += envSizes[envelopeKind] || 0;
  if (blob.length <= headerLen) return null;
  const view = new DataView(blob.buffer, blob.byteOffset + headerLen, blob.byteLength - headerLen);
  try {
    return readGeometry(new Reader(view));
  } catch {
    return null;
  }
}

export function decodeWkb(blob: Uint8Array): Geometry | null {
  try {
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    return readGeometry(new Reader(view));
  } catch {
    return null;
  }
}
