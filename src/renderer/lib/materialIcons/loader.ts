const svgUrls = import.meta.glob('../../assets/material-icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const byBasename: Record<string, string> = {};
for (const [path, url] of Object.entries(svgUrls)) {
  const name = path.split('/').pop()!.replace(/\.svg$/, '');
  byBasename[name] = url;
}

export function getSvgUrl(name: string): string | undefined {
  return byBasename[name];
}

export function hasSvg(name: string): boolean {
  return name in byBasename;
}
