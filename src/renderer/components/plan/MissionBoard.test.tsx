// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FactualFinding, MissionBoardCard, PlanFactualRegister } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useMissionBoardStore } from '../../stores/mission-board-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../checkpoints/FileHistoryView', () => ({
  default: ({ workspaceId, path }: { workspaceId: string; path: string }) => (
    <div data-testid="file-history-view" data-workspace-id={workspaceId} data-path={path} />
  ),
}));
vi.mock('../checkpoints/AttributionPanel', () => ({
  default: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="attribution-panel" data-workspace-id={workspaceId} />
  ),
}));
vi.mock('../checkpoints/RestoreDialog', () => ({ default: () => <div data-testid="restore-dialog" /> }));
vi.mock('./PlanReviewView', () => ({ default: () => <div data-testid="plan-review-view" /> }));

import MissionBoard from './MissionBoard';
import PlanSurfaceView from './PlanSurfaceView';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let fileHistory: ReturnType<typeof vi.fn>;
let diff: ReturnType<typeof vi.fn>;
let boardList: ReturnType<typeof vi.fn>;
let getReviewProjection: ReturnType<typeof vi.fn>;
let factualRegister: ReturnType<typeof vi.fn>;

const EMPTY_REGISTER: PlanFactualRegister = { packages: [], arcFindings: [] };

function activeCard(): MissionBoardCard {
  return {
    packageId: 'WP-P6C',
    workspaceId: 'ws-1',
    planId: 'plan-1',
    title: 'Mission board renderer',
    acceptanceCondition: null,
    state: 'executing',
    assigneeAgentId: 'agent-9',
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    plannedPaths: [{ path: 'src/renderer/components/plan/MissionBoard.tsx', intentKind: 'edit' }],
    liveActivity: [{
      turnId: 'turn-9',
      workspaceId: 'ws-1',
      turnSeq: 9,
      agentId: 'agent-9',
      taskLabel: 'Renderer pass',
      startedAt: 100,
      planId: 'plan-1',
      planItemId: 'WP-P6C',
      planStampSource: 'prompt',
      planStampStatus: 'verified',
      touched: [{ path: 'src/renderer/components/plan/MissionBoard.tsx', op: 'write' }],
      association: 'package-stamp',
      isActive: true,
    }],
    durableTurns: [],
    recoveryOperations: [],
  };
}

async function renderBoard(
  listCards = vi.fn(async () => [activeCard()]),
  readFactualRegister = factualRegister,
): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MissionBoard
        planId="plan-1"
        paneVisible
        listCards={listCards}
        readFactualRegister={readFactualRegister}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  useMissionBoardStore.setState({ boards: {}, factualRegisters: {} });
  useDashboardStore.setState({ openTabs: [], activeTabId: null });
  fileHistory = vi.fn(async () => ({ workspaceId: 'ws-1', path: '', versions: [] }));
  diff = vi.fn(async () => ({
    workspaceId: 'ws-1',
    turnId: 'turn-9',
    witnessed: { available: true, reason: null, label: 'witnessed changes', text: 'diff' },
    window: { available: true, reason: null, label: 'unattributed changes in this window', text: '' },
  }));
  boardList = vi.fn(async () => [activeCard()]);
  getReviewProjection = vi.fn(async () => ({ workspaceId: 'ws-1', planId: 'plan-1' }));
  factualRegister = vi.fn(async () => EMPTY_REGISTER);
  (window as unknown as { api: unknown }).api = {
    checkpoints: { fileHistory, diff },
    plans: { boardList, getReviewProjection, factualRegister },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe('MissionBoard', () => {
  it('renders a polled live touch as activity without changing package completion', async () => {
    await renderBoard();
    const card = container!.querySelector('[data-testid="work-package-card-WP-P6C"]')!;
    expect(card.getAttribute('data-live-active')).toBe('true');
    expect(card.getAttribute('data-state')).toBe('executing');
    expect(card.getAttribute('data-state')).not.toBe('done');
  });

  it('REACHABILITY:wp6-three-signals renders distinct in-flight, asserted, and landed rows without collapsing candidates', async () => {
    const register: PlanFactualRegister = {
      packages: [{
        packageId: 'WP-P6C',
        asserted: [{
          packageId: 'WP-P6C', dispatchAttemptId: 'dispatch-1', scanStatus: 'truncated',
          candidates: [{
            commitOid: '1111111111111111111111111111111111111111', subject: 'candidate one',
            verifiedTrailer: null, scopeOmittedTrailer: null, changedPathsMatchFrozen: true,
          }, {
            commitOid: '2222222222222222222222222222222222222222', subject: 'candidate two',
            verifiedTrailer: null, scopeOmittedTrailer: null, changedPathsMatchFrozen: true,
          }],
        }, {
          packageId: 'WP-P6C', dispatchAttemptId: 'dispatch-2', scanStatus: 'unavailable',
          candidates: [], refusal: 'branch-unresolvable',
        }],
        landed: {
          state: 'done', finalizationId: 'finalization-7', finalizedAt: 7, finalizedBy: 'supervisor',
          declarationCommitOids: ['3333333333333333333333333333333333333333'], gateAttemptIds: ['gate-7'],
        },
        findings: [],
      }],
      arcFindings: [],
    };
    await renderBoard(undefined, vi.fn(async () => register));

    const signals = container!.querySelector('[data-testid="package-signals-WP-P6C"]')!;
    const rows = [...signals.querySelectorAll('[data-signal]')];
    expect(rows.map((row) => row.getAttribute('data-signal')))
      .toEqual(['in-flight', 'asserted', 'landed']);
    expect(rows[0].textContent).toContain('src/renderer/components/plan/MissionBoard.tsx');
    expect(rows[1].textContent).toContain('Commit present, awaiting gate');
    expect(rows[1].textContent).toContain('1111111111111111111111111111111111111111');
    expect(rows[1].textContent).toContain('2222222222222222222222222222222222222222');
    expect(rows[1].textContent).toContain('truncated');
    expect(rows[1].textContent).toContain('unavailable: branch-unresolvable');
    expect(rows[2].textContent).toContain('Finalization finalization-7');
    expect(rows[2].textContent).toContain('333333333333');
  });

  const factualFindingFixtures: Array<[FactualFinding, string]> = [
    [{ kind: 'commit-without-declaration', commitOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'has no completion declaration'],
    [{ kind: 'accepted-not-landed', commitOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', gateAttemptId: 'gate-2', unmet: [{ kind: 'reachability-witness-missing' }] }, 'reachability-witness-missing'],
    [{ kind: 'declaration-without-witness' }, 'without a witnessed package turn'],
    [{ kind: 'declaration-commit-mismatch', declared: 'cccccccccccccccccccccccccccccccccccccccc', asserted: 'dddddddddddddddddddddddddddddddddddddddd' }, 'asserted evidence shows'],
    [{ kind: 'done-without-finalization-citation' }, 'done without a projectable finalization citation'],
    [{ kind: 'arc-contradicts-ledger', wpId: 'WP-P6C', arcClaim: 'done', ledgerState: 'executing' }, 'ledger state is executing'],
    [{ kind: 'arc-row-duplicate', wpId: 'WP-P6C' }, 'duplicate rows'],
    [{ kind: 'evidence-unavailable', scope: 'asserted', detail: 'scan capped' }, 'Asserted evidence unavailable: scan capped'],
  ];

  it.each(factualFindingFixtures)('renders factual disagreement $kind as a visible row', async (finding, expected) => {
    const register: PlanFactualRegister = {
      packages: [{ packageId: 'WP-P6C', asserted: [], landed: null, findings: [finding] }],
      arcFindings: [],
    };
    await renderBoard(undefined, vi.fn(async () => register));
    const row = container!.querySelector(`[data-testid="factual-finding-${finding.kind}"]`)!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain(expected);
  });

  it('keeps a done badge when the async register reports no finalization citation', async () => {
    const doneCard = { ...activeCard(), state: 'done' as const, liveActivity: [] };
    const register: PlanFactualRegister = {
      packages: [{
        packageId: 'WP-P6C', asserted: [], landed: null,
        findings: [{ kind: 'done-without-finalization-citation' }],
      }],
      arcFindings: [],
    };
    await renderBoard(vi.fn(async () => [doneCard]), vi.fn(async () => register));
    const card = container!.querySelector('[data-testid="work-package-card-WP-P6C"]')!;
    expect(card.getAttribute('data-state')).toBe('done');
    expect(card.querySelector('.work-package-card__state')?.textContent).toContain('done');
    expect(container!.querySelector('[data-testid="factual-finding-done-without-finalization-citation"]')).not.toBeNull();
  });

  it('loads the factual register separately and leaves board cards visible when that load fails', async () => {
    const failure = vi.fn(async () => { throw new Error('git projection failed'); });
    await renderBoard(boardList, failure);
    expect(boardList).toHaveBeenCalledWith('plan-1');
    expect(failure).toHaveBeenCalledWith('plan-1');
    expect(container!.querySelector('[data-testid="work-package-card-WP-P6C"]')).not.toBeNull();
    expect(container!.textContent).toContain('Factual register unavailable: git projection failed');
  });

  it('renders both plan-level ARC findings as visible disagreement rows', async () => {
    const register: PlanFactualRegister = {
      packages: [],
      arcFindings: [{ kind: 'arc-status-not-declared' }, { kind: 'arc-status-unparseable' }],
    };
    await renderBoard(undefined, vi.fn(async () => register));
    expect(container!.querySelector('[data-finding="arc-status-not-declared"]')?.textContent)
      .toContain('package status is not declared');
    expect(container!.querySelector('[data-finding="arc-status-unparseable"]')?.textContent)
      .toContain('package status roster is unparseable');
  });

  it('summarizes landed, remaining, and archived package states with the shared rollup semantics', async () => {
    const cards = ['done', 'done', 'done', 'ready', 'blocked', 'archived', 'archived'].map((state, index) => ({
      ...activeCard(),
      packageId: `WP-${index + 1}`,
      state: state as MissionBoardCard['state'],
      liveActivity: [],
    }));
    await renderBoard(vi.fn(async () => cards));
    const progress = container!.querySelector('[data-testid="mission-board-progress"]')!;
    expect(progress.textContent).toContain('3 of 7 landed · 2 remaining · 2 archived');
    expect(progress.getAttribute('aria-label')).toBe('3 of 7 landed, 2 remaining, 2 archived');
  });

  it('opens FileHistoryView for the clicked path with the contributor selected', async () => {
    await renderBoard();
    act(() => {
      (container!.querySelector('.work-package-card__file') as HTMLButtonElement).click();
    });
    expect(fileHistory).toHaveBeenCalledWith(
      'ws-1',
      'src/renderer/components/plan/MissionBoard.tsx',
      { agentId: 'agent-9' },
    );
    const selected = container!.querySelector('[data-selected-turn-id="turn-9"]')!;
    const history = selected.querySelector('[data-testid="file-history-view"]')!;
    expect(history.getAttribute('data-path')).toBe('src/renderer/components/plan/MissionBoard.tsx');
  });

  it('uses a distinct secondary action for the turn-wide diff and AttributionPanel', async () => {
    await renderBoard();
    act(() => {
      (container!.querySelector('[data-testid="turn-diff-turn-9"]') as HTMLButtonElement).click();
    });
    expect(diff).toHaveBeenCalledWith('ws-1', 'turn-9');
    expect(fileHistory).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="attribution-panel"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="file-history-view"]')).toBeNull();
  });

  it('mounts the board by default and lazy-loads change evidence only on first open', async () => {
    useDashboardStore.setState({
      openTabs: [{
        id: 'plan:plan-1',
        kind: 'plan',
        planId: 'plan-1',
        workspaceId: 'ws-1',
        rootDirectory: 'C:/workspace',
        filePath: '',
        pathType: 'windows',
        label: 'Plan',
      }],
      activeTabId: 'plan:plan-1',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <PlanSurfaceView
          workspaceId="ws-1"
        />,
      );
    });
    expect(boardList).toHaveBeenCalledWith('plan-1');
    expect(container!.querySelector('[data-testid="mission-board"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="plan-view-toggle"]')).toBeNull();
    expect(container!.querySelector('[data-testid="plan-view-review"]')).toBeNull();
    expect(container!.querySelector('[data-testid="plan-view-packages"]')).toBeNull();
    const evidence = container!.querySelector('[data-testid="plan-review-evidence"]') as HTMLDetailsElement;
    expect(evidence.open).toBe(false);
    expect(evidence.querySelector('summary')?.textContent).toBe('Change evidence (diff)');
    expect(getReviewProjection).not.toHaveBeenCalled();

    await act(async () => {
      evidence.open = true;
      evidence.dispatchEvent(new Event('toggle'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getReviewProjection).toHaveBeenCalledOnce();
    expect(getReviewProjection).toHaveBeenCalledWith({ workspaceId: 'ws-1', planId: 'plan-1' });
    expect(container!.querySelector('[data-testid="plan-review-view"]')).not.toBeNull();

    await act(async () => {
      evidence.open = false;
      evidence.dispatchEvent(new Event('toggle'));
      evidence.open = true;
      evidence.dispatchEvent(new Event('toggle'));
      await Promise.resolve();
    });
    expect(getReviewProjection).toHaveBeenCalledOnce();
  });
});
