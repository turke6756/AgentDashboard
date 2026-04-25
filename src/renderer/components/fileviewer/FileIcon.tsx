import React from 'react';
import { getFileIconUrl, getFolderIconUrl } from '../../lib/materialIcons';

interface Props {
  name: string;
  isDirectory?: boolean;
  isOpen?: boolean;
  className?: string;
}

export default function FileIcon({ name, isDirectory = false, isOpen = false, className = 'w-4 h-4' }: Props) {
  const url = isDirectory ? getFolderIconUrl(name, isOpen) : getFileIconUrl(name);
  return <img src={url} className={className} alt="" draggable={false} />;
}
