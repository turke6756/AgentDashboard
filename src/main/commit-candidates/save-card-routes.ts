// SC-WP-1J — production Save-card routes (read-only).
//
// This is the bootstrap-side adapter that turns the renderer's `{ workspaceId }`
// request into a full `CandidateReadRequest` and delegates to the committed
// intent-first projection. It owns no new
// assembly logic — the facade already unions scoped inventories, projects
// witnesses, and emits renderer-safe intent-unit DTOs (which are structurally
// `SaveCardInventoryResponse`).
//
// Read-only invariant: every Git seam here is a read (`runGit`/`runGitBytes`
// pass through to the facade, which issues only status/rev-parse/hash-object).
// Nothing in this module mutates the worktree, the index, or any ref.
//
// Repository-scope honesty (architectural invariant "agents share a working
// directory"): the request carries EVERY registered workspace as a candidate,
// each with its own capability probe. The facade's scope discovery then narrows
// to the aliases that actually share the target's worktree, so sibling lanes in
// the same folder are unioned rather than silently dropped.

import * as fs from 'node:fs';

import type { Agent, GitCapability, SaveCardInventoryRequest, SaveCardInventoryResponse, SaveCardScopedRescanRequest, SaveIntentUnitDto, SaveCardPackageSaveability, SaveCardWorkerUnit } from '../../shared/types';
import type { ProtectionAssessment, SaveCardQuotaWeakening } from '../../shared/commit-candidates';
import {
  getAgentsByWorkspace as dbGetAgentsByWorkspace,
  getAgent as dbGetAgent,
  getTurnRecord as dbGetTurnRecord,
  getWorkspaces as dbGetWorkspaces,
  getTurnWitnessReads as dbGetTurnWitnessReads,
  listCommitPathLinks as dbListCommitPathLinks,
  listActivePackageFinalizationsForRepository as dbListActivePackageFinalizationsForRepository,
  listSaveIntentsForRepository as dbListSaveIntentsForRepository,
  listNamedSaveSetMembers as dbListNamedSaveSetMembers,
  getPlan as dbGetPlan,
  getPlanWorkPackage as dbGetPlanWorkPackage,
  createNamedSaveSet as dbCreateNamedSaveSet,
  listPlanningActivityWorktrees as dbListPlanningActivityWorktrees,
  listActivityMergeAttempts as dbListActivityMergeAttempts,
  listActivityMergeConflicts as dbListActivityMergeConflicts,
  listTurnRecords as dbListTurnRecords,
  type TurnRecord,
  type TurnWitnessRead,
} from '../database';
import { probeWorkspaceGit as realProbeWorkspaceGit } from '../git/git-runtime';
import { runGit as realRunGit, runGitBytes as realRunGitBytes } from '../git-checkpoints/git-command';
import {
  CommitCandidateService,
  type CandidateInventoryRead,
  type CandidateWorkspaceInput,
  type CaptureTurnReader,
} from './candidate-service';
import type { RunGitBytesLike, RunGitTextLike } from './dirty-inventory';
import type { TurnWitnessReader } from './witness-projection';
import type { CommitPathLinkReader } from './protection-read';
import { createTurnStampSource, type TurnStampRecordReader } from './stamp-projection';
import type { SaveCardRoutes } from './save-card-ipc';
import { projectWitnesses } from './witness-projection';
import { projectIntentUnits } from './intent-assembler';
import { deriveRepositoryIdentity } from './repository-identity';
import type { RunGit } from '../git/git-runtime';
import type { CommitCandidateSnapshotRegistry } from './snapshot-registry';
import { discoverFirstContactRoots, recordOnboardingDecision, type FirstContactDiscovery } from './onboarding-discovery';
import type { ScratchPolicyStore } from './scratch-policy-store';
import { assessSaveUnitReadiness } from './save-card-readiness';
import { buildPinnedSnapshot } from './pinned-snapshot-build';
import { PinnedSnapshotStore } from './pinned-snapshot-store';

type BundleTurn = Pick<TurnRecord, 'id' | 'agentId' | 'agentTitle' | 'sessionId' | 'startedAt' | 'endedAt'>;

function protectionFields(assessment: ProtectionAssessment | undefined): {
  protectionAssessment: ProtectionAssessment;
  protection: import('../../shared/commit-candidates').ProtectionRung | 'unknown';
} {
  const resolved = assessment ?? { evaluation: 'incomplete' as const };
  const proven = resolved.evaluation === 'complete' ? resolved.rung : resolved.provenRung;
  return {
    protectionAssessment: resolved,
    protection: proven ?? 'unknown',
  };
}

/** Injected seams. Production passes only `gitExe`; the rest default to the live
 *  database / git runtime. Tests override every seam with in-memory fakes. */
export interface SaveCardRoutesDeps {
  /** The internal Git exe already resolved by the checkpoint engine bootstrap. */
  gitExe: string;
  getWorkspaces?: () => ReadonlyArray<{ id: string; path: string; title?: string }>;
  probeWorkspaceGit?: (canonicalWorkspaceDir: string) => Promise<GitCapability>;
  readTurnWitnesses?: TurnWitnessReader;
  readTurnRecord?: TurnStampRecordReader;
  readFallbackTurnIdentity?: (turnId: string) => Pick<TurnRecord, 'id' | 'agentId' | 'sessionId'> | null;
  readCaptureTurns?: CaptureTurnReader;
  readCommitPathLinks?: CommitPathLinkReader;
  readActiveFinalizations?: (repositoryKey: string) => readonly import('../database').PackageFinalization[];
  getAgentsByWorkspace?: (workspaceId: string) => readonly Agent[];
  getAgent?: (agentId: string) => Agent | null;
  readBundleTurns?: (workspaceId: string) => readonly BundleTurn[];
  runGit?: RunGitTextLike;
  runGitBytes?: RunGitBytesLike;
  /** Best-effort canonicalizer; defaults to `fs.realpathSync.native`. */
  realpath?: (p: string) => string;
  /**
   * SC-WP-2L — the latest retention pin quota-weakening warning for the assembled
   * repository (from the WP-2K retention pass). Defaults to none until a warning
   * source is wired in; the Save card simply omits the banner while it is null.
   */
  readQuotaWeakening?: (repositoryKey: string) => SaveCardQuotaWeakening | null;
  listSaveIntents?: typeof dbListSaveIntentsForRepository;
  listNamedSaveSetMembers?: typeof dbListNamedSaveSetMembers;
  getPlan?: typeof dbGetPlan;
  getPlanItem?: typeof dbGetPlanWorkPackage;
  createNamedSaveSet?: typeof dbCreateNamedSaveSet;
  listPlanningActivities?: typeof dbListPlanningActivityWorktrees;
  listActivityMergeAttempts?: typeof dbListActivityMergeAttempts;
  listActivityMergeConflicts?: typeof dbListActivityMergeConflicts;
  /**
   * WP-G — the ONE canonical per-repository snapshot single-flight registry,
   * composed once in `src/main/index.ts` and shared with the preview routes (which
   * run behind a SEPARATE `CommitCandidateService`). When present, the read-only
   * inventory surface routes its inventory+protection assembly through it so a
   * concurrent save-card + preview computes exactly one canonical snapshot. Absent
   * ⇒ the surface computes directly, byte-for-byte as before.
   */
  snapshotRegistry?: CommitCandidateSnapshotRegistry<CandidateInventoryRead>;
  /** Flight generation for a repository (WP-E policy store). Default 0. */
  resolvePolicyGeneration?: (repositoryKey: string) => number;
  scratchPolicyStore?: ScratchPolicyStore;
  /** Records the main-resolved workspace→repository relation for cache invalidation. */
  onRepositoryResolved?: (workspaceId: string, repositoryKey: string) => void;
  /** Called after an authoritative policy write. */
  onPolicyWrite?: (repositoryKey: string) => void;
  /** Durable card snapshot authority; deliberately separate from snapshotRegistry. */
  pinnedSnapshotStore?: PinnedSnapshotStore;
}

function minTime(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length > 0 ? Math.min(...present) : null;
}

function maxTime(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length > 0 ? Math.max(...present) : null;
}

function nonEmpty(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function rendererSafeText(value: string): string {
  return value
    .replace(/\b[A-Za-z]:[\\/][^\s,;]+/g, '[local path]')
    .replace(/(^|\s)\/(?:Users|home|var|tmp|opt|mnt)\/[^\s,;]+/g, '$1[local path]');
}
/** Canonicalize a workspace directory best-effort, mirroring the checkpoint
 *  engine's `canonicalDir` so a probe keys off the same root the facade reads. */
function canonicalDir(realpath: (p: string) => string, p: string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

/**
 * Build the production `SaveCardRoutes`. `getInventory` probes every registered
 * workspace once per request, assembles the repository-scoped candidate set, and
 * returns renderer-safe intent units projected from current evidence.
 */
export function createSaveCardRoutes(deps: SaveCardRoutesDeps): SaveCardRoutes {
  const gitExe = deps.gitExe;
  const getWorkspaces = deps.getWorkspaces ?? dbGetWorkspaces;
  const probeWorkspaceGit = deps.probeWorkspaceGit ?? realProbeWorkspaceGit;
  const readTurnWitnesses = deps.readTurnWitnesses ?? dbGetTurnWitnessReads;
  const readTurnRecord = deps.readTurnRecord ?? dbGetTurnRecord;
  // Read ALL turns for a workspace (large limit), matching the unbounded witness
  // read, so capture-health and protection-edge projection see the same turn
  // universe rather than only the newest default window.
  const readCaptureTurns: CaptureTurnReader =
    deps.readCaptureTurns ??
    ((workspaceId) => dbListTurnRecords(workspaceId, { limit: Number.MAX_SAFE_INTEGER }));
  const readCommitPathLinks = deps.readCommitPathLinks ?? dbListCommitPathLinks;
  const runGit = deps.runGit ?? realRunGit;
  const runGitBytes = deps.runGitBytes ?? realRunGitBytes;
  const realpath = deps.realpath ?? ((p) => fs.realpathSync.native(p));
  const getAgentsByWorkspace = deps.getAgentsByWorkspace ?? dbGetAgentsByWorkspace;
  const getAgent = deps.getAgent ?? dbGetAgent;
  const readBundleTurns = deps.readBundleTurns
    ?? ((workspaceId: string) => dbListTurnRecords(workspaceId, { limit: Number.MAX_SAFE_INTEGER }));
  const snapshotRegistry = deps.snapshotRegistry;
  const resolvePolicyGeneration = deps.resolvePolicyGeneration ?? (() => 0);
  const pinnedSnapshotStore = deps.pinnedSnapshotStore ?? new PinnedSnapshotStore();

  // WP-G — resolve the canonical `repositoryKey` for the flight identity from the
  // target's ALREADY-probed capability (no new heavy scan), so a concurrent
  // save-card + preview on the same repository coalesce onto one snapshot. Best
  // effort: a repo-less / unresolvable target yields null and the caller computes
  // directly (uncoalesced), exactly as before the registry existed.
  async function resolveRepositoryKey(
    workspaceDir: string,
    capability: Pick<GitCapability, 'commonDirQueueKey'>,
  ): Promise<string | null> {
    const boundRunGit: RunGit = async (args) => {
      const result = await runGit(workspaceDir, args, {
        gitExe, allowNonzero: true, timeoutMs: 10_000, maxBytes: 1 << 20,
      });
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    };
    const outcome = await deriveRepositoryIdentity(workspaceDir, capability, {
      runGit: boundRunGit,
      platform: process.platform,
      realpath,
      fileExists: (candidate) => fs.existsSync(candidate),
    });
    return outcome.ok ? outcome.repositoryKey : null;
  }

  const service = new CommitCandidateService({
    runGit,
    runGitBytes,
    readTurnWitnesses,
    stampSource: createTurnStampSource(readTurnRecord),
    readFallbackTurnIdentity: deps.readFallbackTurnIdentity ?? dbGetTurnRecord,
    readFallbackAgent: getAgent,
    readCaptureTurns,
    readCommitPathLinks,
    readActiveFinalizations: deps.readActiveFinalizations ?? dbListActivePackageFinalizationsForRepository,
    readQuotaWeakening: deps.readQuotaWeakening,
    readActivePlanningWorktrees: deps.listPlanningActivities ?? dbListPlanningActivityWorktrees,
    listSaveIntents: deps.listSaveIntents ?? dbListSaveIntentsForRepository,
    listNamedSaveSetMembers: deps.listNamedSaveSetMembers ?? dbListNamedSaveSetMembers,
    getPlan: deps.getPlan ?? dbGetPlan,
    getPlanItem: deps.getPlanItem ?? dbGetPlanWorkPackage,
  });
  const latestReadByWorkspace = new Map<string, CandidateInventoryRead>();
  const latestDiscoveryByWorkspace = new Map<string, FirstContactDiscovery>();

  function validatedScopePath(req: SaveCardScopedRescanRequest): string {
    const raw = Buffer.from(req.pathBytesBase64, 'base64');
    if (raw.length === 0 || raw.toString('base64') !== req.pathBytesBase64
        || raw.includes(0) || !Buffer.from(raw.toString('utf8'), 'utf8').equals(raw)) {
      throw new Error('scoped rescan requires a valid UTF-8 Git path');
    }
    const pathspec = raw.toString('utf8').replace(/\\/g, '/').replace(/\/+$/, '');
    if (pathspec === '.' || pathspec.startsWith('/') || /^[A-Za-z]:\//.test(pathspec)
        || pathspec.split('/').some((part) => part === '..' || part === '')) {
      throw new Error('scoped rescan path must stay inside the repository');
    }
    const latest = latestReadByWorkspace.get(req.workspaceId);
    if (!latest) throw new Error('scoped rescan is stale; refresh save progress first');
    return pathspec;
  }

  async function buildInventory(
    req: SaveCardInventoryRequest,
    scopePathspec?: string,
  ): Promise<SaveCardInventoryResponse> {
    const registeredWorkspaces = getWorkspaces();
    const capabilityByWorkspaceId = new Map<string, GitCapability>();
    const workspaceTitleById = new Map(
      registeredWorkspaces.map((workspace) => [workspace.id, workspace.title ?? workspace.id]),
    );
    const workspaces: CandidateWorkspaceInput[] = await Promise.all(
      registeredWorkspaces.map(async (ws): Promise<CandidateWorkspaceInput> => {
        const workspaceDir = canonicalDir(realpath, ws.path);
        const capability = await probeWorkspaceGit(workspaceDir);
        capabilityByWorkspaceId.set(ws.id, capability);
        return {
          workspaceId: ws.id,
          workspaceDir,
          capability: {
            commonDirQueueKey: capability.commonDirQueueKey,
            workspacePrefix: capability.workspacePrefix,
            repoRoot: capability.repoRoot,
          },
          gitExe,
        };
      }),
    );

    const request = {
      targetWorkspaceId: req.workspaceId,
      workspaces,
      ...(scopePathspec ? { scopePathspec } : {}),
      ...(req.inventoryTimeBudgetMs !== undefined
        ? { inventoryTimeBudgetMs: req.inventoryTimeBudgetMs }
        : {}),
    };
    const target = workspaces.find((ws) => ws.workspaceId === req.workspaceId);
    const repositoryKey = snapshotRegistry && target
      ? await resolveRepositoryKey(target.workspaceDir, target.capability)
      : null;
    const read = snapshotRegistry && repositoryKey
      ? await (scopePathspec ? snapshotRegistry.acquireScoped : snapshotRegistry.acquire).call(
          snapshotRegistry,
          { repositoryKey, policyGeneration: resolvePolicyGeneration(repositoryKey) },
          () => service.assembleInventory(request),
        )
      : await service.assembleInventory(request);
    if (!scopePathspec) latestReadByWorkspace.set(req.workspaceId, read);
    deps.onRepositoryResolved?.(req.workspaceId, read.inventory.repository.repositoryKey);
    let onboarding: import('../../shared/types').SaveCardOnboardingPrompt | null = null;
    if (!scopePathspec && deps.scratchPolicyStore && target?.capability.repoRoot) {
      try {
        const discovery = await discoverFirstContactRoots({
          repoRoot: target.capability.repoRoot,
          pathspec: target.capability.workspacePrefix ?? undefined,
          repositoryKey: read.inventory.repository.repositoryKey,
          workspaceKey: req.workspaceId,
          policyStore: deps.scratchPolicyStore,
          runGitBytes,
          gitExe,
        });
        latestDiscoveryByWorkspace.set(req.workspaceId, discovery);
        if (discovery.presentation) {
          onboarding = {
            presentation: discovery.presentation,
            recommendations: discovery.recommendations.map((item) => ({
              pathBytesBase64: item.pathBytesBase64,
              displayPath: item.displayPath,
              countLabel: item.countLabel,
            })),
          };
        }
      } catch (error) {
        // Setup guidance is advisory. A discovery failure must never hide the
        // already-computed save inventory or persist completion.
        console.warn('[save-card-onboarding] bounded discovery unavailable:', error);
        latestDiscoveryByWorkspace.delete(req.workspaceId);
      }
    } else if (scopePathspec) {
      const discovery = latestDiscoveryByWorkspace.get(req.workspaceId);
      if (discovery?.presentation) {
        onboarding = {
          presentation: discovery.presentation,
          recommendations: discovery.recommendations.map((item) => ({
            pathBytesBase64: item.pathBytesBase64,
            displayPath: item.displayPath,
            countLabel: item.countLabel,
          })),
        };
      }
    }
    const quotaWeakening = read.quotaWeakening;

    const includedWorkspaceIds = new Set(read.inventory.repository.workspaces.map(
      (workspace) => workspace.workspaceId,
    ));
    const agentRows = [...includedWorkspaceIds].flatMap((workspaceId) => getAgentsByWorkspace(workspaceId));
    const agents = new Map(agentRows.map((agent) => [agent.id, agent]));
    const bundleTurns = [...includedWorkspaceIds].flatMap((workspaceId) => readBundleTurns(workspaceId));
    const turns = new Map(bundleTurns.map((turn) => [turn.id, turn]));
    const witnesses = [...includedWorkspaceIds].flatMap((workspaceId) => readTurnWitnesses(workspaceId));
    for (const agentId of new Set(witnesses.flatMap((witness) => witness.agentId ? [witness.agentId] : []))) {
      if (!agents.has(agentId)) {
        const agent = getAgent(agentId);
        if (agent) agents.set(agentId, agent);
      }
    }
    for (const ownerId of new Set(witnesses.flatMap((witness) => witness.ownerAgentId ? [witness.ownerAgentId] : []))) {
      if (!agents.has(ownerId)) {
        const owner = getAgent(ownerId);
        if (owner) agents.set(ownerId, owner);
      }
    }

    const projectedWitnesses = projectWitnesses(
      read.inventory.repository,
      read.inventory.entries,
      readTurnWitnesses,
      createTurnStampSource(readTurnRecord),
    ).map((witness) => {
      const turn = turns.get(witness.turnId);
      const agent = witness.agentId ? agents.get(witness.agentId) : null;
      return {
        ...witness,
        sessionId: turn?.sessionId,
        agentTitle: agent
          ? rendererSafeText(nonEmpty(agent.title, turn?.agentTitle || 'Unknown agent'))
          : null,
        agentIdentityResolved: Boolean(agent && turn && turn.agentId === witness.agentId),
      };
    });
    const workspaceIds = read.inventory.repository.workspaces.map((workspace) => workspace.workspaceId);
    const intents = (deps.listSaveIntents ?? dbListSaveIntentsForRepository)(
      read.inventory.repository.repositoryKey,
      workspaceIds,
    );
    const assembly = projectIntentUnits({
      inventory: read.inventory,
      witnesses: projectedWitnesses,
      intents,
      namedMembers: (deps.listNamedSaveSetMembers ?? dbListNamedSaveSetMembers)(
        read.inventory.repository.repositoryKey,
      ),
      topology: { components: read.components } as import('./component-assembler').ComponentAssembly,
    });
    const entriesById = new Map(read.inventory.entries.map((entry) => [entry.entryId, entry]));
    const workerByAgentId = new Map([...agents].map(([agentId, agent]) => {
      const agentWitnesses = witnesses.filter((witness) => witness.agentId === agentId);
      const agentTurns = agentWitnesses.map((witness) => turns.get(witness.turnId))
        .filter((turn): turn is BundleTurn => Boolean(turn));
      const worker: SaveCardWorkerUnit = {
        agentId,
        name: rendererSafeText(nonEmpty(agent.title, agentTurns.find((turn) => turn.agentTitle)?.agentTitle || 'Unknown agent')),
        roleDescription: rendererSafeText(nonEmpty(agent.roleDescription, 'No role description recorded.')),
        kind: agent.isSupervisor ? 'supervisor' : agent.isWorker || agent.isSupervised ? 'worker' : 'agent',
        startedAt: minTime(agentTurns.map((turn) => turn.startedAt)),
        endedAt: maxTime(agentTurns.map((turn) => turn.endedAt ?? turn.startedAt)),
        turnCount: new Set(agentTurns.map((turn) => turn.id)).size,
        memberEntryIds: [],
      };
      return [agentId, worker] as const;
    }));
    const targetCapability = capabilityByWorkspaceId.get(req.workspaceId);
    const saveability: SaveCardPackageSaveability = targetCapability && !targetCapability.repoRoot
      ? {
          saveable: false,
          reason: 'no-repository',
          workspaceId: req.workspaceId,
          workspaceTitle: workspaceTitleById.get(req.workspaceId) ?? req.workspaceId,
          refusal: {
            stage: 'saveability', code: 'save-card-no-repository',
            message: `Saveability stage refused because workspace '${workspaceTitleById.get(req.workspaceId) ?? req.workspaceId}' has no Git repository.`,
          },
        }
      : { saveable: true };
    const intentUnits = assembly.intentUnits.map((unit): SaveIntentUnitDto => {
      const plan = unit.intent.planId ? (deps.getPlan ?? dbGetPlan)(unit.intent.planId) : null;
      const planItem = unit.intent.planItemId
        ? (deps.getPlanItem ?? dbGetPlanWorkPackage)(unit.intent.planItemId) : null;
      const componentHealth = unit.topologyComponentIds.flatMap((id) =>
        read.captureHealthByComponentId[id] ? [read.captureHealthByComponentId[id]] : []);
      const unitEntries = unit.memberEntryIds.map((entryId) => entriesById.get(entryId)!);
      return {
        intentId: unit.intent.id,
        kind: unit.intent.kind,
        saveUnitId: unit.intent.id,
        saveUnitKind: unit.intent.kind,
        title: unit.intent.title,
        state: unit.intent.state,
        plan: plan ? { id: plan.id, title: plan.slug ?? plan.path } : null,
        planItem: planItem ? { id: planItem.id, title: planItem.title } : null,
        members: unitEntries.map((entry) => ({
          entry,
          ...protectionFields(read.protectionAssessmentByEntryId?.[entry.entryId]),
        })),
        contributors: unit.contributingAgentIds.flatMap((id) => {
          const worker = workerByAgentId.get(id);
          return worker ? [worker] : [];
        }),
        topologyEvidence: {
          componentIds: unit.topologyComponentIds,
          pathsWithMultipleTurns: unit.concurrency.pathsWithMultipleIntents,
          captureHealth: {
            turns: componentHealth.flatMap((health) => health.turns),
            captureOutage: componentHealth.some((health) => health.captureOutage),
            pathsWithoutFinalizationEdge: [...new Set(componentHealth.flatMap(
              (health) => health.pathsWithoutFinalizationEdge))],
          },
        },
        concurrencyCases: [],
        saveability,
        saveGate: assessSaveUnitReadiness(unitEntries),
        membershipStale: assembly.staleNamedSaveSetIds.includes(unit.intent.id),
        presentation: unit.presentation,
        supervisorIds: unit.supervisorIds,
        mergeReason: unit.mergeReason,
      };
    });
    const members = (entryIds: readonly string[]) => entryIds.map((entryId) => ({
      entry: entriesById.get(entryId)!,
      ...protectionFields(read.protectionAssessmentByEntryId?.[entryId]),
    }));
    const unwitnessed = members(assembly.unwitnessedEntryIds);
    const legacyTaskIdentityUnavailable = members(
      assembly.legacyTaskIdentityUnavailableEntryIds,
    );
    const fallbackUnits = assembly.fallbackUnits.map((unit): SaveIntentUnitDto => {
      const componentIds = [...new Set(unit.memberEntryIds.flatMap((entryId) =>
        read.components.filter((component) => component.dirtyEntryIds.includes(entryId))
          .map((component) => component.componentId)))].sort();
      const componentHealth = componentIds.flatMap((id) =>
        read.captureHealthByComponentId[id] ? [read.captureHealthByComponentId[id]] : []);
      const worker = workerByAgentId.get(unit.identityAssessment.agentId);
      const unitEntries = unit.memberEntryIds.map((entryId) => entriesById.get(entryId)!);
      return {
        intentId: unit.saveUnitId,
        kind: unit.saveUnitKind,
        saveUnitId: unit.saveUnitId,
        saveUnitKind: unit.saveUnitKind,
        title: unit.title,
        state: 'open',
        plan: null,
        planItem: null,
        members: unitEntries.map((entry) => ({
          entry,
          ...protectionFields(read.protectionAssessmentByEntryId?.[entry.entryId]),
        })),
        contributors: worker ? [worker] : [],
        topologyEvidence: {
          componentIds,
          pathsWithMultipleTurns: [],
          captureHealth: {
            turns: componentHealth.flatMap((health) => health.turns),
            captureOutage: componentHealth.some((health) => health.captureOutage),
            pathsWithoutFinalizationEdge: [...new Set(componentHealth.flatMap(
              (health) => health.pathsWithoutFinalizationEdge))],
          },
        },
        concurrencyCases: [],
        saveability,
        saveGate: assessSaveUnitReadiness(unitEntries),
        identityAssessment: {
          evaluation: 'complete',
          agentTitle: unit.identityAssessment.agentTitle,
        },
        coarseIdentityWarning: unit.coarseIdentityWarning,
      };
    });
    const witnessedUngroupable = members(assembly.witnessedUngroupableEntryIds);
    const planningActivities = (deps.listPlanningActivities ?? dbListPlanningActivityWorktrees)()
      .filter((activity) => activity.logicalWorkspaceId === req.workspaceId)
      .map((activity) => {
        const attempt = (deps.listActivityMergeAttempts ?? dbListActivityMergeAttempts)(activity.executionRunId)[0] ?? null;
        const conflicts = attempt
          ? (deps.listActivityMergeConflicts ?? dbListActivityMergeConflicts)(attempt.id)
          : [];
        const status = activity.state === 'merge-conflicted' ? 'merge-conflicted' as const
          : activity.state === 'merge-pending' ? 'saved-in-plan-promotion-pending' as const
            : activity.state === 'recovery-required' ? 'recovery-required' as const
              : activity.state === 'cleaned' ? 'cleaned' as const
                : activity.promotedHeadOid ? 'promoted' as const : 'active' as const;
        const plan = (deps.getPlan ?? dbGetPlan)(activity.planId);
        return {
          executionRunId: activity.executionRunId,
          planId: activity.planId,
          planTitle: plan ? plan.slug ?? plan.path : activity.planId,
          status,
          promotedHeadOid: activity.promotedHeadOid,
          latestAttemptId: attempt?.id ?? null,
          conflicts: conflicts.map((conflict) => ({
            pathBytesBase64: conflict.pathBytesBase64,
            displayPath: Buffer.from(conflict.pathBytesBase64, 'base64').toString('utf8'),
            baseBlobOid: conflict.baseBlobOid,
            primaryBlobOid: conflict.primaryBlobOid,
            activityBlobOid: conflict.activityBlobOid,
            resolution: conflict.resolution,
          })),
          failureCode: activity.failureCode,
        };
      });
    const legacyFinalizations = (deps.readActiveFinalizations ?? dbListActivePackageFinalizationsForRepository)(
      read.inventory.repository.repositoryKey,
    ).filter((row) => row.contractVersion !== 2).map((row) => ({
      finalizationId: row.id,
      packageId: row.packageId,
      packageRevision: row.packageRevision,
      finalizationKind: row.finalizationKind,
      boundaryStatus: row.boundaryStatus,
      finalizedAt: row.finalizedAt,
    }));
    const headResult = target?.capability.repoRoot
      ? await runGit(target.capability.repoRoot, ['rev-parse', 'HEAD'], {
          gitExe, allowNonzero: true, timeoutMs: 10_000, maxBytes: 1024,
        })
      : null;
    const snapshot = await buildPinnedSnapshot({
      store: pinnedSnapshotStore,
      identityBefore: () => ({
        head: read.inventory.repository.repositoryKey,
        index: read.inventory.topologyDigest,
      }),
      identityAfter: () => ({
        head: read.inventory.repository.repositoryKey,
        index: read.inventory.topologyDigest,
      }),
      assemble: () => ({
        repositoryKey: read.inventory.repository.repositoryKey,
        targetWorkspaceId: req.workspaceId,
        policyGeneration: resolvePolicyGeneration(read.inventory.repository.repositoryKey),
        pinnedHeadOid: headResult?.code === 0 ? headResult.stdout.trim() || null : null,
        indexFingerprint: read.inventory.topologyDigest,
        scopePathspecBytes: scopePathspec ?? null,
        boundaryInputs: {
          completeness: read.inventory.completeness ?? 'complete',
          stopReasons: read.inventoryEvidence?.observedStopReasons ?? [],
        },
        entries: read.inventory.entries,
        grouping: [
          ...assembly.intentUnits.map((unit) => ({
            saveUnitId: unit.intent.id, saveUnitKind: unit.intent.kind,
            memberEntryIds: unit.memberEntryIds,
          })),
          ...assembly.fallbackUnits.map((unit) => ({
            saveUnitId: unit.saveUnitId, saveUnitKind: unit.saveUnitKind,
            memberEntryIds: unit.memberEntryIds,
          })),
        ],
        intentUnits: assembly.intentUnits,
        fallbackUnits: assembly.fallbackUnits,
        componentEntryIds: Object.fromEntries(read.components.map((component) => [
          component.componentId, component.dirtyEntryIds,
        ])),
        unattributedEntryIds: read.inventory.unattributedEntryIds,
        stability: 'stable' as const,
      }),
    });
    return {
      intentUnits,
      fallbackUnits,
      unwitnessed,
      legacyTaskIdentityUnavailable,
      witnessedUngroupable,
      legacyFinalizations,
      planningActivities,
      quotaWeakening,
      onboarding,
      computeState: {
        scope: scopePathspec ? 'scoped' : 'global',
        inventory: {
          completeness: read.inventory.completeness ?? 'complete',
          dirtyCorpusStopReasons: read.inventoryEvidence?.observedStopReasons ?? [],
          observedEntries: read.inventoryEvidence?.observedEntries ?? read.inventory.entries.length,
          observedStatusBytes: read.inventoryEvidence?.observedStatusBytes ?? 0,
          observedPathBytes: read.inventoryEvidence?.observedPathBytes ?? 0,
          totalsExact: read.inventoryEvidence?.totalsExact ?? read.inventory.totalsExact ?? true,
        },
        protection: {
          assessment: read.protectionAssessment ?? { evaluation: 'complete', rung: 'unprotected' },
          checkpointStopReasons: read.protectionStopReasons ?? [],
        },
        snapshot: {
          snapshotId: snapshot.snapshotId,
          boundaryInputFingerprint: snapshot.boundaryInputFingerprint,
          repositoryKey: snapshot.repositoryKey,
          stability: snapshot.stability,
        },
      },
    };
  }

  const getInventory = (req: SaveCardInventoryRequest) => buildInventory(req);

  async function scopedRescan(req: SaveCardScopedRescanRequest): Promise<SaveCardInventoryResponse> {
    return buildInventory(req, validatedScopePath(req));
  }

  async function completeOnboarding(
    req: import('../../shared/types').SaveCardOnboardingDecisionRequest,
  ): Promise<import('../../shared/types').SaveCardOnboardingDecisionResponse> {
    if (!deps.scratchPolicyStore) throw new Error('save tracking setup is unavailable');
    const discovery = latestDiscoveryByWorkspace.get(req.workspaceId);
    if (!discovery) throw new Error('save tracking setup is stale; refresh before deciding');
    const record = recordOnboardingDecision(
      deps.scratchPolicyStore,
      discovery,
      req.decision,
      req.selectedPathBytesBase64,
    );
    latestDiscoveryByWorkspace.delete(req.workspaceId);
    deps.onPolicyWrite?.(discovery.repositoryKey);
    return { policyGeneration: record.policyGeneration };
  }

  async function adoptAllAsBaseline(
    req: import('../../shared/types').SaveCardAdoptBaselineRequest,
  ): Promise<import('../../shared/types').SaveCardAdoptBaselineResponse> {
    const inventory = await getInventory(req);
    const read = latestReadByWorkspace.get(req.workspaceId);
    if (!read) throw new Error('fresh intent inventory unavailable');
    if (inventory.computeState?.inventory.completeness === 'partial') {
      return { ok: false, code: 'adopt-all-inventory-partial',
        message: 'Adopt all is unavailable because the workspace inventory is incomplete. Run a complete scan first.' };
    }
    const members = inventory.unwitnessed ?? [];
    if (members.length === 0) throw new Error('there are no unwitnessed changes to adopt');
    const createdAt = Date.now();
    const title = `Baseline ${new Date(createdAt).toISOString().slice(0, 10)}`;
    const intent = (deps.createNamedSaveSet ?? dbCreateNamedSaveSet)({
      workspaceId: req.workspaceId,
      repositoryKey: read.inventory.repository.repositoryKey,
      title,
      inventoryDigest: read.inventory.topologyDigest,
      members: members.map((member) => ({
        entryId: member.entry.entryId,
        pathBytesBase64: member.entry.path.pathBytesBase64,
      })),
      createdAt,
    });
    return { ok: true, intentId: intent.id, title: intent.title, memberCount: members.length };
  }

  return { getInventory, scopedRescan, adoptAllAsBaseline, completeOnboarding };
}
