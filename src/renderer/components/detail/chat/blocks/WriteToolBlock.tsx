import React from 'react';
import { ToolBlockProps } from './GenericToolBlock';
import EditToolBlock from './EditToolBlock';

interface WriteInput {
  file_path?: string;
  content?: string;
}

export default function WriteToolBlock(props: ToolBlockProps) {
  const rec = (props.input ?? {}) as WriteInput;
  const editShaped = {
    file_path: rec.file_path,
    old_string: '',
    new_string: rec.content ?? '',
    replace_all: false,
  };
  return <EditToolBlock {...props} input={editShaped} isCreate />;
}
