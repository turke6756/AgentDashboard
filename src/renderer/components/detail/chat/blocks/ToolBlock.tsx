import React from 'react';
import GenericToolBlock, { ToolBlockProps } from './GenericToolBlock';
import EditToolBlock from './EditToolBlock';
import WriteToolBlock from './WriteToolBlock';
import BashToolBlock from './BashToolBlock';
import TodoWriteToolBlock from './TodoWriteToolBlock';
import ReadToolBlock from './ReadToolBlock';
import GrepToolBlock from './GrepToolBlock';
import GlobToolBlock from './GlobToolBlock';

const REGISTRY: Record<string, React.FC<ToolBlockProps>> = {
  Edit: EditToolBlock,
  Write: WriteToolBlock,
  Bash: BashToolBlock,
  TodoWrite: TodoWriteToolBlock,
  Read: ReadToolBlock,
  Grep: GrepToolBlock,
  Glob: GlobToolBlock,
};

export default function ToolBlock(props: ToolBlockProps) {
  const Component = REGISTRY[props.toolName] || GenericToolBlock;
  return <Component {...props} />;
}

export type { ToolBlockProps };
