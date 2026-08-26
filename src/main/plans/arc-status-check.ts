import { readFile } from 'node:fs/promises';
import type {
  FactualFinding,
  MissionBoardPackageState,
  PlanArcFinding,
} from '../../shared/types';

const STATES = new Set<MissionBoardPackageState>([
  'ready', 'executing', 'blocked', 'done', 'archived',
]);

export interface ArcStatusCheckResult {
  arcFindings: PlanArcFinding[];
  packageFindings: Map<string, FactualFinding[]>;
  content: Buffer | null;
  unavailableDetail?: string;
}

function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

function add(
  findings: Map<string, FactualFinding[]>,
  packageId: string,
  finding: FactualFinding,
): void {
  findings.set(packageId, [...(findings.get(packageId) ?? []), finding]);
}

/** Read and compare only the exact `## Package status` roster. The function has
 * no write dependency and opens ARC.md exclusively through readFile. */
export async function checkArcAgainstLedger(
  _planId: string,
  arcPath: string,
  ledgerStates: ReadonlyMap<string, MissionBoardPackageState>,
  read: typeof readFile = readFile,
): Promise<ArcStatusCheckResult> {
  let content: Buffer;
  try {
    content = await read(arcPath);
  } catch (error) {
    return {
      arcFindings: [{ kind: 'arc-status-not-declared' }],
      packageFindings: new Map(),
      content: null,
      unavailableDetail: error instanceof Error ? error.message : 'ARC.md unavailable',
    };
  }
  const lines = content.toString('utf8').split(/\r?\n/);
  const headings = lines.flatMap((line, index) => line === '## Package status' ? [index] : []);
  if (headings.length === 0) {
    return { arcFindings: [{ kind: 'arc-status-not-declared' }], packageFindings: new Map(), content };
  }
  const malformed = (): ArcStatusCheckResult => ({
    arcFindings: [{ kind: 'arc-status-unparseable' }], packageFindings: new Map(), content,
  });
  if (headings.length !== 1) return malformed();
  let row = headings[0] + 1;
  while (row < lines.length && lines[row].trim() === '') row += 1;
  const headers = row < lines.length ? cells(lines[row]) : null;
  const separators = row + 1 < lines.length ? cells(lines[row + 1]) : null;
  if (!headers || !separators || headers.length !== separators.length
      || !separators.every((cell) => /^:?-{3,}:?$/.test(cell))) return malformed();
  const wpIndex = headers.indexOf('WP');
  const stateIndex = headers.indexOf('State');
  if (wpIndex < 0 || stateIndex < 0 || wpIndex === stateIndex) return malformed();

  const claims: Array<{ packageId: string; state: MissionBoardPackageState }> = [];
  for (row += 2; row < lines.length; row += 1) {
    if (lines[row].trim() === '' || /^##\s/.test(lines[row])) break;
    const values = cells(lines[row]);
    if (!values || values.length !== headers.length) return malformed();
    const packageId = values[wpIndex];
    const state = values[stateIndex] as MissionBoardPackageState;
    if (!ledgerStates.has(packageId) || !STATES.has(state)) return malformed();
    claims.push({ packageId, state });
  }
  if (claims.length === 0) return malformed();

  const packageFindings = new Map<string, FactualFinding[]>();
  const counts = new Map<string, number>();
  for (const claim of claims) counts.set(claim.packageId, (counts.get(claim.packageId) ?? 0) + 1);
  for (const [packageId, count] of counts) {
    if (count > 1) add(packageFindings, packageId, { kind: 'arc-row-duplicate', wpId: packageId });
  }
  for (const claim of claims) {
    const ledgerState = ledgerStates.get(claim.packageId)!;
    if (claim.state !== ledgerState) add(packageFindings, claim.packageId, {
      kind: 'arc-contradicts-ledger', wpId: claim.packageId,
      arcClaim: claim.state, ledgerState,
    });
  }
  return { arcFindings: [], packageFindings, content };
}
