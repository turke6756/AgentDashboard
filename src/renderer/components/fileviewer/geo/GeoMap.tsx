import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// One-time default-icon fix for bundlers
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

interface Props {
  geojson: any;
  highlightIndex?: number | null;
  onFeatureClick?: (index: number) => void;
  className?: string;
}

export default function GeoMap({ geojson, highlightIndex, onFeatureClick, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.GeoJSON | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) return;

    const map = L.map(containerRef.current, {
      preferCanvas: true,
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true,
    }).setView([20, 0], 2);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layerRef.current) {
      map.removeLayer(layerRef.current);
      layerRef.current = null;
    }
    if (!geojson) return;

    const defaultStyle = {
      color: '#3794ff',
      weight: 2,
      fillColor: '#3794ff',
      fillOpacity: 0.25,
    };

    const layer = L.geoJSON(geojson, {
      style: () => defaultStyle,
      pointToLayer: (_feature, latlng) =>
        L.circleMarker(latlng, {
          radius: 4,
          color: '#3794ff',
          weight: 1.5,
          fillColor: '#3794ff',
          fillOpacity: 0.7,
        }),
      onEachFeature: (feature, lyr) => {
        const idx = (feature as any)._idx;
        if (onFeatureClick !== undefined && idx !== undefined) {
          lyr.on('click', () => onFeatureClick(idx));
        }
      },
    });

    layer.addTo(map);
    layerRef.current = layer;

    try {
      const bounds = layer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [20, 20], maxZoom: 16 });
      }
    } catch {}
  }, [geojson, onFeatureClick]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.eachLayer((lyr: any) => {
      const idx = lyr.feature?._idx;
      const isHL = highlightIndex !== null && highlightIndex !== undefined && idx === highlightIndex;
      if (lyr.setStyle) {
        lyr.setStyle(
          isHL
            ? { color: '#f5a623', weight: 3, fillColor: '#f5a623', fillOpacity: 0.45 }
            : { color: '#3794ff', weight: 2, fillColor: '#3794ff', fillOpacity: 0.25 },
        );
      }
    });
  }, [highlightIndex]);

  return <div ref={containerRef} className={className} />;
}
