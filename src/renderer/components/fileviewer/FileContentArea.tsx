import React from 'react';
import type { PathType } from '../../../shared/types';
import { useFileContentCache } from './useFileContentCache';
import { detectFileType } from './fileTypeUtils';
import FileContentRenderer from './FileContentRenderer';
import ImageRenderer from './ImageRenderer';
import PdfRenderer from './PdfRenderer';
import GeoTiffRenderer from './GeoTiffRenderer';
import ShapefileRenderer from './ShapefileRenderer';
import GeoPackageRenderer from './GeoPackageRenderer';

interface Props {
  tabId: string;
  filePath: string;
  pathType: PathType;
}

export default function FileContentArea({ tabId, filePath, pathType }: Props) {
  const fileType = filePath ? detectFileType(filePath) : null;

  // Media + geospatial binary types are fetched via media:// protocol — skip text file reading entirely
  const isMediaType =
    fileType === 'image' ||
    fileType === 'pdf' ||
    fileType === 'geotiff' ||
    fileType === 'shapefile' ||
    fileType === 'geopackage';
  const { content, loading } = useFileContentCache(tabId, filePath, pathType, isMediaType);

  if (!filePath) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-400 font-sans text-sm  ">
          Select a file from the tree
        </div>
      </div>
    );
  }

  // Render media types directly — they don't need file content
  if (fileType === 'image') {
    return <ImageRenderer filePath={filePath} pathType={pathType} />;
  }
  if (fileType === 'pdf') {
    return <PdfRenderer filePath={filePath} pathType={pathType} />;
  }
  if (fileType === 'geotiff') {
    return <GeoTiffRenderer filePath={filePath} />;
  }
  if (fileType === 'shapefile') {
    return <ShapefileRenderer filePath={filePath} />;
  }
  if (fileType === 'geopackage') {
    return <GeoPackageRenderer filePath={filePath} />;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-300 font-sans text-sm animate-pulse">Loading file...</div>
      </div>
    );
  }

  if (!content) return null;

  return (
    <FileContentRenderer
      content={content.content}
      filePath={filePath}
      pathType={pathType}
      error={content.error}
    />
  );
}
