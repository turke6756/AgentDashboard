export type FileType = 'markdown' | 'code' | 'text' | 'image' | 'pdf' | 'binary';

const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown']);

const CODE_EXTS: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.rb': 'ruby',
  '.java': 'java', '.kt': 'kotlin', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
  '.cs': 'csharp', '.swift': 'swift', '.php': 'php', '.r': 'r',
  '.sql': 'sql', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.ps1': 'powershell', '.bat': 'batch', '.cmd': 'batch',
  '.html': 'html', '.htm': 'html', '.xml': 'xml', '.svg': 'xml',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.sass': 'sass',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
  '.dockerfile': 'dockerfile', '.docker': 'dockerfile',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.lua': 'lua', '.vim': 'vim', '.el': 'lisp',
  '.zig': 'zig', '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang', '.hs': 'haskell', '.ml': 'ocaml',
  '.proto': 'protobuf', '.tf': 'hcl',
  '.makefile': 'makefile', '.cmake': 'cmake',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.svg']);
const PDF_EXTS = new Set(['.pdf']);

const BINARY_EXTS = new Set([
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.db', '.sqlite', '.sqlite3',
]);

const TEXT_EXTS = new Set([
  '.txt', '.log', '.env', '.gitignore', '.gitattributes', '.editorconfig',
  '.prettierrc', '.eslintrc', '.npmrc', '.nvmrc',
]);

function getExtension(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const name = normalized.split('/').pop() || '';

  // Handle special filenames
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return '.dockerfile';
  if (lower === 'makefile') return '.makefile';

  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return name.substring(dotIndex).toLowerCase();
}

export function detectFileType(filePath: string): FileType {
  const ext = getExtension(filePath);
  if (!ext) return 'text';
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (ext in CODE_EXTS) return 'code';
  if (BINARY_EXTS.has(ext)) return 'binary';
  if (TEXT_EXTS.has(ext)) return 'text';
  // Unknown extension - treat as text
  return 'text';
}

export function detectLanguage(filePath: string): string {
  const ext = getExtension(filePath);
  return CODE_EXTS[ext] || 'text';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getFileIconName(filePath: string, isDirectory: boolean): string {
  if (isDirectory) return 'Folder';
  
  const name = filePath.split(/[/\\]/).pop() || '';
  const lowerName = name.toLowerCase();
  const ext = (name.includes('.') ? '.' + name.split('.').pop() : '').toLowerCase();
  
  // Special filenames
  if (lowerName === 'package.json') return 'Package';
  if (lowerName === 'package-lock.json') return 'Lock';
  if (lowerName === 'tsconfig.json') return 'Settings2';
  if (lowerName === '.gitignore') return 'GitBranch';
  if (lowerName === 'dockerfile') return 'Container';
  if (lowerName === 'makefile') return 'FileTerminal';
  if (lowerName.includes('license')) return 'FileCheck';
  
  const type = detectFileType(filePath);
  
  switch (type) {
    case 'markdown': return 'FileText';
    case 'image': return 'FileImage';
    case 'pdf': return 'FileText'; // FileText as placeholder if FileArchive isn't right
    case 'code':
      if (['.ts', '.tsx'].includes(ext)) return 'FileType2';
      if (['.js', '.jsx'].includes(ext)) return 'FileType';
      if (['.json'].includes(ext)) return 'Braces';
      if (['.css', '.scss', '.less'].includes(ext)) return 'Palette';
      if (['.html', '.xml', '.svg'].includes(ext)) return 'Code2';
      if (['.py'].includes(ext)) return 'FileCode2';
      if (['.rs', '.go', '.rb', '.java', '.kt', '.c', '.cpp', '.cs'].includes(ext)) return 'Cpu';
      if (['.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1'].includes(ext)) return 'Terminal';
      if (['.sql'].includes(ext)) return 'Database';
      return 'FileCode';
    case 'text':
      if (['.log'].includes(ext)) return 'ScrollText';
      if (['.env', '.ini', '.cfg', '.conf', '.toml', '.yaml', '.yml'].includes(ext)) return 'Settings';
      return 'FileText';
    case 'binary':
      if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext)) return 'Archive';
      if (['.exe', '.dll', '.bin'].includes(ext)) return 'Binary';
      if (['.db', '.sqlite', '.sqlite3'].includes(ext)) return 'Database';
      return 'FileBox';
    default: return 'File';
  }
}
