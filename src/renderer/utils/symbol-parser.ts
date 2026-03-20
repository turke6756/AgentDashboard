export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable' | 'interface';
  line: number;
}

const REGEX_PATTERNS: Record<string, { kind: CodeSymbol['kind'], pattern: RegExp }[]> = {
  // TypeScript / JavaScript
  typescript: [
    { kind: 'class', pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/ },
    { kind: 'interface', pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/ },
    { kind: 'function', pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/ },
    { kind: 'variable', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/ },
    // Simplified method detection (rough approximation)
    { kind: 'method', pattern: /^\s*(?:public|private|protected|static|async)*\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*[:{]/ },
  ],
  javascript: [
    { kind: 'class', pattern: /^\s*(?:export\s+)?class\s+([A-Za-z0-9_$]+)/ },
    { kind: 'function', pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/ },
    { kind: 'variable', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/ },
  ],
  // Python
  python: [
    { kind: 'class', pattern: /^\s*class\s+([A-Za-z0-9_]+)/ },
    { kind: 'function', pattern: /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/ },
  ],
  // Rust
  rust: [
    { kind: 'function', pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/ },
    { kind: 'class', pattern: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/ }, // Mapping structs/enums to 'class' for simplicity
  ],
  // Go
  go: [
    { kind: 'function', pattern: /^func\s+([A-Za-z0-9_]+)/ },
    { kind: 'class', pattern: /^type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/ },
  ]
};

export function parseSymbols(content: string, language: string): CodeSymbol[] {
  const lines = content.split('\n');
  const symbols: CodeSymbol[] = [];
  
  // Normalize language key
  const langKey = language.toLowerCase();
  const patterns = REGEX_PATTERNS[langKey] || 
                  (langKey === 'tsx' || langKey === 'jsx' ? REGEX_PATTERNS.typescript : []) ||
                  (langKey === 'js' ? REGEX_PATTERNS.javascript : []);

  if (patterns.length === 0) return [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('//') || line.trim().startsWith('#')) continue; // Skip comments

    for (const { kind, pattern } of patterns) {
      const match = line.match(pattern);
      if (match && match[1]) {
        symbols.push({
          name: match[1],
          kind,
          line: i + 1 // 1-based line number
        });
        break; // Only match one symbol per line
      }
    }
  }

  return symbols;
}
