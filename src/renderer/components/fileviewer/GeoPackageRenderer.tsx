import React, { useEffect, useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import initSqlJs from 'sql.js';
// @ts-ignore - Vite url import
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { fetchFileBuffer, reprojectGeoJsonInPlace, parseWktToProj4Name } from './geo/geoUtils';
import GeoMap from './geo/GeoMap';
import AttributeTable from './geo/AttributeTable';
import { decodeGeoPackageGeometry } from './geo/wkb';
import { Toolbar, Stat, LoadingState, ErrorState } from './ShapefileRenderer';

interface Props {
  filePath: string;
}

interface LayerSummary {
  tableName: string;
  dataType: string;
  description: string;
  srsId: number;
  geomColumn: string | null;
  geomType: string | null;
}

interface LoadedDb {
  db: any;
  layers: LayerSummary[];
}

interface LoadedLayer {
  rows: Record<string, any>[];
  geojson: any;
  crsName: string | null;
  geomType: string | null;
}

let sqlJsPromise: Promise<any> | null = null;
function getSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({ locateFile: () => sqlWasmUrl });
  }
  return sqlJsPromise;
}

function queryAll(db: any, sql: string, params: any[] = []): Record<string, any>[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows: Record<string, any>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function tableExists(db: any, name: string): boolean {
  const rows = queryAll(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [name]);
  return rows.length > 0;
}

export default function GeoPackageRenderer({ filePath }: Props) {
  const [loadedDb, setLoadedDb] = useState<LoadedDb | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [layerData, setLayerData] = useState<LoadedLayer | null>(null);
  const [layerLoading, setLayerLoading] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState<'map' | 'table' | 'split'>('split');

  useEffect(() => {
    let cancelled = false;
    setLoadedDb(null);
    setError(null);
    setSelectedTable(null);
    setLayerData(null);

    (async () => {
      try {
        const [SQL, buf] = await Promise.all([getSqlJs(), fetchFileBuffer(filePath)]);
        if (cancelled) return;
        const db = new SQL.Database(new Uint8Array(buf));

        if (!tableExists(db, 'gpkg_contents')) {
          throw new Error('Not a valid GeoPackage (missing gpkg_contents table)');
        }

        const contents = queryAll(
          db,
          `SELECT table_name, data_type, identifier, description, srs_id FROM gpkg_contents ORDER BY data_type, table_name`,
        );
        const geomCols = tableExists(db, 'gpkg_geometry_columns')
          ? queryAll(db, `SELECT table_name, column_name, geometry_type_name FROM gpkg_geometry_columns`)
          : [];
        const geomMap = new Map<string, { column_name: string; geometry_type_name: string }>();
        for (const g of geomCols) {
          geomMap.set(String(g.table_name), {
            column_name: String(g.column_name),
            geometry_type_name: String(g.geometry_type_name),
          });
        }

        const layers: LayerSummary[] = contents.map((c) => {
          const tn = String(c.table_name);
          const gm = geomMap.get(tn);
          return {
            tableName: tn,
            dataType: String(c.data_type),
            description: String(c.identifier || c.description || ''),
            srsId: Number(c.srs_id),
            geomColumn: gm?.column_name ?? null,
            geomType: gm?.geometry_type_name ?? null,
          };
        });

        if (cancelled) return;
        setLoadedDb({ db, layers });

        const firstFeatures = layers.find((l) => l.dataType === 'features');
        if (firstFeatures) setSelectedTable(firstFeatures.tableName);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  useEffect(() => {
    if (!loadedDb || !selectedTable) return;
    const layer = loadedDb.layers.find((l) => l.tableName === selectedTable);
    if (!layer) return;
    if (layer.dataType !== 'features' || !layer.geomColumn) {
      setLayerData({ rows: [], geojson: null, crsName: null, geomType: null });
      return;
    }

    let cancelled = false;
    setLayerLoading(true);
    setLayerData(null);

    (async () => {
      try {
        const db = loadedDb.db;

        let crsName: string | null = null;
        if (layer.srsId && layer.srsId !== 4326) {
          const srs = queryAll(
            db,
            `SELECT organization, organization_coordsys_id, definition FROM gpkg_spatial_ref_sys WHERE srs_id=?`,
            [layer.srsId],
          )[0];
          if (srs) {
            const authCode =
              srs.organization && srs.organization_coordsys_id
                ? `${String(srs.organization).toUpperCase()}:${srs.organization_coordsys_id}`
                : null;
            if (authCode === 'EPSG:4326') {
              crsName = 'EPSG:4326';
            } else if (srs.definition) {
              crsName = parseWktToProj4Name(String(srs.definition));
            } else if (authCode) {
              crsName = authCode;
            }
          }
        }

        const geomCol = layer.geomColumn;
        const rowsRaw = queryAll(db, `SELECT * FROM "${layer.tableName}" LIMIT 20000`);

        const features: any[] = [];
        const attrRows: Record<string, any>[] = [];
        for (let i = 0; i < rowsRaw.length; i++) {
          const row = rowsRaw[i];
          const geomBlob = row[geomCol];
          const attrs: Record<string, any> = {};
          for (const k of Object.keys(row)) {
            if (k !== geomCol) attrs[k] = row[k];
          }
          attrRows.push(attrs);
          let geometry: any = null;
          if (geomBlob && geomBlob instanceof Uint8Array) {
            geometry = decodeGeoPackageGeometry(geomBlob);
          }
          features.push({
            type: 'Feature',
            _idx: i,
            geometry,
            properties: attrs,
          });
        }
        const geojson = { type: 'FeatureCollection', features };
        if (crsName) reprojectGeoJsonInPlace(geojson, crsName);

        if (!cancelled) {
          setLayerData({
            rows: attrRows,
            geojson,
            crsName: crsName ?? (layer.srsId === 4326 ? 'EPSG:4326' : `SRS ${layer.srsId}`),
            geomType: layer.geomType,
          });
          setLayerLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(`Failed to load layer "${selectedTable}": ${e?.message ?? e}`);
          setLayerLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadedDb, selectedTable]);

  if (error && !loadedDb) return <ErrorState message={error} />;
  if (!loadedDb) return <LoadingState label="Opening GeoPackage…" />;

  const featureLayers = loadedDb.layers.filter((l) => l.dataType === 'features');
  const tileLayers = loadedDb.layers.filter((l) => l.dataType === 'tiles');
  const selected = loadedDb.layers.find((l) => l.tableName === selectedTable) || null;

  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 border-r border-surface-3 bg-surface-1 overflow-auto">
        <SectionHeader>Feature layers · {featureLayers.length}</SectionHeader>
        {featureLayers.map((l) => (
          <LayerItem
            key={l.tableName}
            active={l.tableName === selectedTable}
            onClick={() => setSelectedTable(l.tableName)}
            icon={<Icons.Shapes className="w-3.5 h-3.5" />}
            title={l.tableName}
            subtitle={l.geomType || 'feature'}
          />
        ))}
        {tileLayers.length > 0 && (
          <>
            <SectionHeader>Tile layers · {tileLayers.length}</SectionHeader>
            {tileLayers.map((l) => (
              <LayerItem
                key={l.tableName}
                active={false}
                onClick={() => {}}
                icon={<Icons.Image className="w-3.5 h-3.5" />}
                title={l.tableName}
                subtitle={`SRS ${l.srsId} (preview not supported)`}
                disabled
              />
            ))}
          </>
        )}
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        {selected && layerData && !layerLoading && (
          <>
            <Toolbar
              leftInfo={
                <>
                  <Stat label="Layer" value={selected.tableName} />
                  <Stat label="Features" value={layerData.rows.length.toLocaleString()} />
                  <Stat label="Geom" value={layerData.geomType ?? '—'} />
                  <Stat label="CRS" value={layerData.crsName ?? 'unknown'} />
                </>
              }
              view={view}
              onViewChange={setView}
            />
            <div className="flex-1 min-h-0 flex">
              {(view === 'map' || view === 'split') && (
                <GeoMap
                  geojson={layerData.geojson}
                  highlightIndex={hover}
                  className={`h-full ${view === 'split' ? 'w-1/2 border-r border-surface-3' : 'w-full'}`}
                />
              )}
              {(view === 'table' || view === 'split') && (
                <div className={`h-full ${view === 'split' ? 'w-1/2' : 'w-full'}`}>
                  <AttributeTable
                    rows={layerData.rows}
                    highlightIndex={hover}
                    onRowHover={setHover}
                  />
                </div>
              )}
            </div>
          </>
        )}
        {layerLoading && <LoadingState label="Reading layer…" />}
        {!selected && !layerLoading && (
          <div className="flex items-center justify-center h-full text-sm text-gray-400 font-sans">
            Select a layer from the sidebar
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-gray-500 font-sans">
      {children}
    </div>
  );
}

function LayerItem({
  active,
  onClick,
  icon,
  title,
  subtitle,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px] font-sans transition-colors ${
        disabled
          ? 'text-gray-500 cursor-not-allowed'
          : active
          ? 'bg-accent-blue/30 text-gray-100'
          : 'text-gray-300 hover:bg-surface-2'
      }`}
    >
      <span className="shrink-0 text-accent-green">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block truncate">{title}</span>
        <span className="block text-[10px] text-gray-500 truncate">{subtitle}</span>
      </span>
    </button>
  );
}
