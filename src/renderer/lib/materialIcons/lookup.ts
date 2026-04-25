import { fileIcons } from './fileIcons';
import { folderIcons } from './folderIcons';
import type { FileIcon, FolderIcon } from './types';
import { getSvgUrl, hasSvg } from './loader';

function resolveIconName(name: string, clone?: { base: string }): string {
  if (hasSvg(name)) return name;
  if (clone && hasSvg(clone.base)) return clone.base;
  return name;
}

const fileByName = new Map<string, FileIcon>();
const fileByExt = new Map<string, FileIcon>();

for (const icon of fileIcons.icons) {
  if (icon.disabled) continue;
  for (const n of icon.fileNames ?? []) {
    const key = n.toLowerCase();
    if (!fileByName.has(key)) fileByName.set(key, icon);
  }
  for (const e of icon.fileExtensions ?? []) {
    const key = e.toLowerCase();
    if (!fileByExt.has(key)) fileByExt.set(key, icon);
  }
}

const folderByName = new Map<string, FolderIcon>();
const specificTheme = folderIcons.find((t) => t.name === 'specific');
const folderDefault = specificTheme?.defaultIcon.name ?? 'folder';
const folderRoot = specificTheme?.rootFolder?.name ?? 'folder-root';

if (specificTheme?.icons) {
  for (const icon of specificTheme.icons) {
    for (const n of icon.folderNames) {
      const key = n.toLowerCase();
      if (!folderByName.has(key)) folderByName.set(key, icon);
    }
  }
}

function findFileIcon(fileName: string): FileIcon | undefined {
  const lower = fileName.toLowerCase();

  const exact = fileByName.get(lower);
  if (exact) return exact;

  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.');
    const byExt = fileByExt.get(ext);
    if (byExt) return byExt;
  }

  return undefined;
}

export function getFileIconUrl(fileName: string): string {
  const icon = findFileIcon(fileName);
  const rawName = icon?.name ?? fileIcons.defaultIcon.name;
  const resolved = resolveIconName(rawName, icon?.clone);
  return getSvgUrl(resolved) ?? getSvgUrl(fileIcons.defaultIcon.name)!;
}

export function getFolderIconUrl(folderName: string, isOpen: boolean): string {
  const lower = folderName.toLowerCase();
  const icon = folderByName.get(lower);
  const rawName = icon?.name ?? folderDefault;
  const resolvedBase = resolveIconName(rawName, icon?.clone);

  if (isOpen) {
    const openName = `${resolvedBase}-open`;
    if (hasSvg(openName)) return getSvgUrl(openName)!;
  }

  return getSvgUrl(resolvedBase) ?? getSvgUrl(folderDefault)!;
}

export function getRootFolderIconUrl(isOpen: boolean): string {
  if (isOpen) {
    const openName = `${folderRoot}-open`;
    if (hasSvg(openName)) return getSvgUrl(openName)!;
  }
  return getSvgUrl(folderRoot) ?? getSvgUrl(folderDefault)!;
}
