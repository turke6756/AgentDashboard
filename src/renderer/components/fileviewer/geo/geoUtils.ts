import proj4 from 'proj4';

export async function fetchFileBuffer(filePath: string): Promise<ArrayBuffer> {
  const res = await fetch(`media://file/${encodeURIComponent(filePath)}`);
  if (!res.ok) throw new Error(`Failed to read file (${res.status})`);
  return await res.arrayBuffer();
}

export async function fetchFileText(filePath: string): Promise<string | null> {
  try {
    const res = await fetch(`media://file/${encodeURIComponent(filePath)}`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export function siblingPath(filePath: string, newExt: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const dir = slash >= 0 ? filePath.substring(0, slash + 1) : '';
  const name = slash >= 0 ? filePath.substring(slash + 1) : filePath;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.substring(0, dot) : name;
  return dir + base + newExt;
}

export function registerCommonCrs() {
  // proj4 ships with EPSG:4326 and EPSG:4269 by default; add common web ones
  if (!proj4.defs('EPSG:3857')) {
    proj4.defs(
      'EPSG:3857',
      '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
    );
  }
}

registerCommonCrs();

export function reprojectGeoJsonInPlace(geojson: any, sourceCrs: string | null) {
  if (!sourceCrs) return geojson;
  if (sourceCrs === 'EPSG:4326' || sourceCrs === 'WGS84') return geojson;
  if (!proj4.defs(sourceCrs)) return geojson;

  const reproj = (coords: any): any => {
    if (typeof coords[0] === 'number') {
      const [x, y] = proj4(sourceCrs, 'EPSG:4326', [coords[0], coords[1]]);
      return coords.length > 2 ? [x, y, coords[2]] : [x, y];
    }
    return coords.map(reproj);
  };

  const walkGeom = (g: any) => {
    if (!g) return;
    if (g.type === 'GeometryCollection') {
      g.geometries?.forEach(walkGeom);
    } else if (g.coordinates) {
      g.coordinates = reproj(g.coordinates);
    }
  };

  if (geojson.type === 'FeatureCollection') {
    geojson.features?.forEach((f: any) => walkGeom(f.geometry));
  } else if (geojson.type === 'Feature') {
    walkGeom(geojson.geometry);
  } else {
    walkGeom(geojson);
  }
  return geojson;
}

export function parseWktToProj4Name(wkt: string): string | null {
  if (!wkt) return null;
  // Try to pull an EPSG authority code
  const authMatch = wkt.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/i);
  if (authMatch) {
    const code = `EPSG:${authMatch[1]}`;
    try {
      if (!proj4.defs(code)) proj4.defs(code, wkt);
    } catch {}
    return code;
  }
  // Register the WKT itself under a synthetic name
  try {
    const synthetic = `WKT:${hashString(wkt)}`;
    if (!proj4.defs(synthetic)) proj4.defs(synthetic, wkt);
    return synthetic;
  } catch {
    return null;
  }
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
