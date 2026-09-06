import * as fs from 'node:fs';

import type {
  GitCapability,
  PlanCandidatePreviewRequest,
  SaveCardFleetAdhocRefusalCode,
} from '../../shared/types';
import type {
  DirtyEntry,
  SaveRefusalStage,
  WitnessedCommitProvenance,
} from '../../shared/commit-candidates';
import { BUNDLE_CONTRACT_VERSION } from '../../shared/constants';
import {
  getWorkspaces as dbGetWorkspaces,
  getTurnRecord as dbGetTurnRecord,
  getAgent as dbGetAgent,
  getAgentContextStats as dbGetAgentContextStats,
  getTurnWitnessReads as dbGetTurnWitnessReads,
  getPackageFinalization as dbGetPackageFinalization,
  getPlanWorkPackage as dbGetPlanWorkPackage,
  listPlanWorkPackagePaths as dbListPlanWorkPackagePaths,
  listCommitPathLinks as dbListCommitPathLinks,
  listTurnRecords as dbListTurnRecords,
  listActivePackageFinalizationsForRepository as dbListActivePackageFinalizationsForRepository,
  getSaveIntentFinalization as dbGetSaveIntentFinalization,
  type PackageFinalization,
  type PlanWorkPackage,
  type PlanWorkPackagePath,
  type SaveIntentFinalization,
} from '../database';
import { probeWorkspaceGit as realProbeWorkspaceGit, type RunGit } from '../git/git-runtime';
import { runGit as realRunGit, runGitBytes as realRunGitBytes } from '../git-checkpoints/git-command';
import {
  CommitCandidateService,
  type CandidateBuildContext,
  type CandidateInventoryRead,
  type CandidateLedgerLink,
  type CandidateReadRequest,
  type CandidateWorkspaceInput,
  type CaptureTurnReader,
} from '../commit-engine/candidate-service';
import { ComposeLockRegistry } from '../commit-engine/compose-lock-registry';
import { CheckpointQueue } from '../git-checkpoints/checkpoint-queue';
import { computeIndexFingerprint } from '../commit-engine/index-fingerprint';
import {
  readCurrentCommitRepresentation,
  type CommitRepresentation,
  type CommitRepresentationEntry,
} from '../commit-engine/commit-representation';
import { createTurnStampSource, type TurnStampRecordReader } from '../commit-engine/stamp-projection';
import type { RunGitBytesLike, RunGitTextLike } from '../commit-engine/dirty-inventory';
import type { TurnWitnessReader } from '../commit-engine/witness-projection';
import type { CommitPathLinkReader } from '../commit-engine/protection-read';
import { parseFinalizationManifest, resolvePinnedSelectionDrift } from '../commit-engine/pinned-selection-drift';
import { deriveRepositoryIdentity } from '../commit-engine/repository-identity';
import type { CommitCandidateSnapshotRegistry } from '../commit-engine/snapshot-registry';
import type {
  FinalizePlanItemDoneRequest,
  PlanCandidatePreviewRoutes,
  PlanFinalizeEnrichmentResult,
} from './plan-ipc';

const OID_RE = /^[0-9a-f]{40,64}$/;
const HEAD_TIMEOUT_MS = 10_000;

export class SaveCardFinalizeRefusalError extends Error {
  constructor(
    message: string,
    readonly code: SaveCardFleetAdhocRefusalCode,
    readonly workspaceId: string,
    readonly workspaceTitle: string,
    readonly stage: SaveRefusalStage = 'boundary-capture',
    readonly paths?: string[],
  ) {
    super(message);
    this.name = 'SaveCardFinalizeRefusalError';
  }
}

export interface PlanCandidateRoutesDeps {
  gitExe: string;
  getWorkspaces?: () => ReadonlyArray<{ id: string; path: string; title?: string }>;
  probeWorkspaceGit?: (canonicalWorkspaceDir: string) => Promise<GitCapability>;
  readTurnWitnesses?: TurnWitnessReader;
  readTurnRecord?: TurnStampRecordReader;
  readCaptureTurns?: CaptureTurnReader;
  readWitnessedProvenance?: (
    workspaceId: string,
    turnId: string,
  ) => Readonly<WitnessedCommitProvenance> | null;
  readCommitPathLinks?: CommitPathLinkReader;
  listRepoCommitPathLinks?: (repositoryKey: string) => readonly CandidateLedgerLink[];
  readActiveFinalizations?: (repositoryKey: string) => readonly PackageFinalization[];
  readActivePlanningWorktrees?: import('../commit-engine/candidate-service').CandidateServiceDeps['readActivePlanningWorktrees'];
  listSaveIntents?: import('../commit-engine/candidate-service').CandidateServiceDeps['listSaveIntents'];
  listNamedSaveSetMembers?: import('../commit-engine/candidate-service').CandidateServiceDeps['listNamedSaveSetMembers'];
  getPlan?: import('../commit-engine/candidate-service').CandidateServiceDeps['getPlan'];
  getPackageFinalization?: (id: string) => PackageFinalization | null;
  getSaveIntentFinalization?: (id: string) => SaveIntentFinalization | null;
  getPlanWorkPackage?: (id: string) => PlanWorkPackage | null;
  listPlanWorkPackagePaths?: (id: string) => PlanWorkPackagePath[];
  runGit?: RunGitTextLike;
  runGitBytes?: RunGitBytesLike;
  realpath?: (p: string) => string;
  contractVersion?: number;
  assembleInventory?: (req: CandidateReadRequest) => Promise<CandidateInventoryRead>;
  queue?: CheckpointQueue;
  captureFinalizationBoundary?: (
    workspaceId: string,
    label: string,
  ) => Promise<{ oid: string; treeOid: string }>;
  composeLocks?: ComposeLockRegistry;
  snapshotRegistry?: CommitCandidateSnapshotRegistry<CandidateInventoryRead>;
  resolvePolicyGeneration?: (repositoryKey: string) => number;
  onRepositoryResolved?: (workspaceId: string, repositoryKey: string) => void;
}

interface PreviewScope {
  context: Omit<CandidateBuildContext, 'currentCommitReps' | 'finalizations'>;
  repoRoot: string;
  gitExe: string;
  pinnedHeadOid: string | null;
  runGit: RunGitTextLike;
  runGitBytes: RunGitBytesLike;
  entriesById: ReadonlyMap<string, DirtyEntry>;
  componentEntryIds: ReadonlyMap<string, readonly string[]>;
}

function canonicalDir(realpath: (p: string) => string, p: string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

export function createPlanCandidateRoutes(deps: PlanCandidateRoutesDeps): PlanCandidatePreviewRoutes {
  const gitExe = deps.gitExe;
  const getWorkspaces = deps.getWorkspaces ?? dbGetWorkspaces;
  const probeWorkspaceGit = deps.probeWorkspaceGit ?? realProbeWorkspaceGit;
  const readTurnWitnesses = deps.readTurnWitnesses ?? dbGetTurnWitnessReads;
  const readTurnRecord = deps.readTurnRecord ?? dbGetTurnRecord;
  const readCaptureTurns: CaptureTurnReader =
    deps.readCaptureTurns
    ?? ((workspaceId) => dbListTurnRecords(workspaceId, { limit: Number.MAX_SAFE_INTEGER }));
  const readWitnessedProvenance = deps.readWitnessedProvenance
    ?? ((workspaceId: string, turnId: string): WitnessedCommitProvenance | null => {
      const turn = dbGetTurnRecord(turnId);
      if (!turn || turn.workspaceId !== workspaceId) return null;
      const localCheckpointRefs = [
        turn.beforeReady ? turn.beforeRef : null,
        turn.afterReady ? turn.afterRef : null,
      ].filter((ref): ref is string => typeof ref === 'string' && ref.startsWith('refs/lares/'));
      if (!turn.agentId) return { assistedBy: [], localCheckpointRefs };
      const agent = dbGetAgent(turn.agentId);
      const stats = dbGetAgentContextStats(turn.agentId);
      const assistedBy = agent && stats && turn.sessionId && stats.sessionId === turn.sessionId
        ? [{ provider: agent.provider, model: stats.model }]
        : [];
      return { assistedBy, localCheckpointRefs };
    });
  const readCommitPathLinks = deps.readCommitPathLinks ?? dbListCommitPathLinks;
  const listRepoCommitPathLinks = deps.listRepoCommitPathLinks
    ?? ((repositoryKey: string) => dbListCommitPathLinks(repositoryKey));
  const getPackageFinalization = deps.getPackageFinalization ?? dbGetPackageFinalization;
  const getSaveIntentFinalization = deps.getSaveIntentFinalization ?? dbGetSaveIntentFinalization;
  const getPlanWorkPackage = deps.getPlanWorkPackage ?? dbGetPlanWorkPackage;
  const listPlanWorkPackagePaths = deps.listPlanWorkPackagePaths ?? dbListPlanWorkPackagePaths;
  const runGit = deps.runGit ?? realRunGit;
  const runGitBytes = deps.runGitBytes ?? realRunGitBytes;
  const realpath = deps.realpath ?? ((p) => fs.realpathSync.native(p));
  const contractVersion = deps.contractVersion ?? BUNDLE_CONTRACT_VERSION;
  const composeLocks = deps.composeLocks ?? new ComposeLockRegistry();
  const snapshotRegistry = deps.snapshotRegistry;
  const resolvePolicyGeneration = deps.resolvePolicyGeneration ?? (() => 0);

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
    readCaptureTurns,
    readWitnessedProvenance,
    readCommitPathLinks,
    readActiveFinalizations: deps.readActiveFinalizations ?? dbListActivePackageFinalizationsForRepository,
    readActivePlanningWorktrees: deps.readActivePlanningWorktrees,
    listSaveIntents: deps.listSaveIntents,
    listNamedSaveSetMembers: deps.listNamedSaveSetMembers,
    getPlan: deps.getPlan,
    getPlanItem: deps.getPlanWorkPackage,
    tokenStore: { composeLocks },
  });
  const assembleInventory = deps.assembleInventory
    ?? ((req: CandidateReadRequest) => service.assembleInventory(req));

  async function resolvePinnedHead(repoRoot: string): Promise<string | null> {
    const result = await runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
      gitExe,
      allowNonzero: true,
      timeoutMs: HEAD_TIMEOUT_MS,
      maxBytes: 4096,
    });
    const oid = result.stdout.trim();
    return result.code === 0 && OID_RE.test(oid) ? oid : null;
  }

  async function assembleScope(workspaceId: string, coalesce = false): Promise<PreviewScope> {
    const registeredWorkspaces = getWorkspaces();
    const workspaceRow = registeredWorkspaces.find((workspace) => workspace.id === workspaceId);
    if (!workspaceRow) {
      throw new SaveCardFinalizeRefusalError(
        `Cannot pin this package because it references an unknown workspace: ${workspaceId}.`,
        'save-card-unknown-workspace',
        workspaceId,
        workspaceId,
        'saveability',
      );
    }
    const workspaces: CandidateWorkspaceInput[] = await Promise.all(
      registeredWorkspaces.map(async (ws): Promise<CandidateWorkspaceInput> => {
        const workspaceDir = canonicalDir(realpath, ws.path);
        const capability = await probeWorkspaceGit(workspaceDir);
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

    const target = workspaces.find((ws) => ws.workspaceId === workspaceId);
    if (!target) {
      throw new SaveCardFinalizeRefusalError(
        `Cannot pin this package because it references an unknown workspace: ${workspaceId}.`,
        'save-card-unknown-workspace',
        workspaceId,
        workspaceRow.title ?? workspaceId,
        'saveability',
      );
    }
    const repoRoot = target.capability.repoRoot;
    if (!repoRoot) {
      const workspaceTitle = workspaceRow.title ?? workspaceId;
      throw new SaveCardFinalizeRefusalError(
        `No git repository — cannot pin/commit from workspace '${workspaceTitle}'.`,
        'save-card-no-repository',
        workspaceId,
        workspaceTitle,
        'saveability',
      );
    }

    const request: CandidateReadRequest = { targetWorkspaceId: workspaceId, workspaces };
    const repositoryKey = coalesce && snapshotRegistry
      ? await resolveRepositoryKey(target.workspaceDir, target.capability)
      : null;
    if (repositoryKey) deps.onRepositoryResolved?.(workspaceId, repositoryKey);
    const read = snapshotRegistry && repositoryKey
      ? await snapshotRegistry.acquire(
          { repositoryKey, policyGeneration: resolvePolicyGeneration(repositoryKey) },
          () => assembleInventory(request),
        )
      : await assembleInventory(request);

    const repository = read.inventory.repository;
    const [pinnedHeadOid, indexFingerprint] = await Promise.all([
      resolvePinnedHead(repoRoot),
      computeIndexFingerprint({ repoRoot, runGitBytes, runGit, gitExe }),
    ]);
    const ledger = listRepoCommitPathLinks(repository.repositoryKey);

    return {
      context: {
        repository,
        inventory: read.inventory,
        components: read.components,
        ledger,
        protectionByEntryId: read.protectionByEntryId,
        protectionAssessmentByEntryId: read.protectionAssessmentByEntryId,
        ...(read.intentUnits ? { intentUnits: read.intentUnits } : {}),
        ...(read.fallbackUnits ? { fallbackUnits: read.fallbackUnits } : {}),
        ...(read.witnessedProvenanceByTurnId
          ? { witnessedProvenanceByTurnId: read.witnessedProvenanceByTurnId }
          : {}),
        pinnedHeadOid,
        indexFingerprint,
        contractVersion,
      },
      repoRoot,
      gitExe,
      pinnedHeadOid,
      runGit,
      runGitBytes,
      entriesById: new Map(read.inventory.entries.map((entry) => [entry.entryId, entry])),
      componentEntryIds: new Map(read.components.map((c) => [c.componentId, c.dirtyEntryIds])),
    };
  }

  function selectionMembers(
    scope: PreviewScope,
    selectedComponentIds: readonly string[],
    selectedUnattributedEntryIds: readonly string[],
  ): DirtyEntry[] {
    const memberIds = new Set<string>();
    for (const componentId of selectedComponentIds) {
      for (const entryId of scope.componentEntryIds.get(componentId) ?? []) memberIds.add(entryId);
    }
    for (const entryId of selectedUnattributedEntryIds) memberIds.add(entryId);
    return [...memberIds]
      .map((entryId) => scope.entriesById.get(entryId))
      .filter((entry): entry is DirtyEntry => entry !== undefined);
  }

  async function resolveReps(
    scope: PreviewScope,
    members: readonly DirtyEntry[],
  ): Promise<Map<string, CommitRepresentation>> {
    const pairs = await Promise.all(
      members.map(async (entry): Promise<[string, CommitRepresentation]> => {
        const repEntry: CommitRepresentationEntry = {
          path: entry.path,
          commitPathspecs: entry.commitPathspecs,
          expectedWorktreeState: entry.expectedWorktreeState,
          rawWorktreeBlobOid: entry.rawWorktreeBlobOid,
        };
        const rep = await readCurrentCommitRepresentation({
          repoRoot: scope.repoRoot,
          pinnedHeadOid: scope.pinnedHeadOid,
          entry: repEntry,
          gitExe: scope.gitExe,
          runGit: scope.runGit,
          runGitBytes: scope.runGitBytes,
          queue: deps.queue,
          commonDirQueueKey: deps.queue
            ? scope.context.repository.objectDatabaseKey
            : undefined,
        });
        return [entry.entryId, rep];
      }),
    );
    return new Map(pairs);
  }

  function adaptIntentFinalization(row: SaveIntentFinalization): PackageFinalization {
    return {
      id: row.id, packageId: row.saveUnitId, repositoryKey: row.repositoryKey,
      finalizationKind: row.saveUnitKind === 'task' ? 'plan-package' : 'fleet-adhoc',
      planId: null, planItemId: null, packageRevision: row.revision,
      finalizedAt: row.finalizedAt, finalizedBy: row.finalizedBy,
      checkpointTurnId: null, checkpointOid: row.checkpointOid,
      boundaryRef: row.boundaryRef, boundaryStatus: row.boundaryStatus,
      lifecycleStatus: row.lifecycleStatus,
      supersededByFinalizationId: row.supersededByFinalizationId,
      releasedAt: null, memberManifestJson: row.memberManifestJson,
      contractVersion: 2, failureReason: row.failureReason,
      createdFromWorkspaceId: null,
    };
  }

  function readFinalization(id: string): {
    finalization: PackageFinalization;
    saveUnit: import('../commit-engine/candidate-service').CandidateSaveUnitFinalization;
  } | null {
    const legacy = getPackageFinalization(id);
    if (legacy) {
      return {
        finalization: legacy,
        saveUnit: {
          finalizationId: legacy.id,
          saveUnitId: legacy.packageId,
          saveUnitKind: legacy.finalizationKind === 'plan-package' ? 'task' : 'named-save-set',
          revision: legacy.packageRevision,
          planId: legacy.planId,
          planItemId: legacy.planItemId,
        },
      };
    }
    const row = getSaveIntentFinalization(id);
    if (!row) return null;
    return {
      finalization: adaptIntentFinalization(row),
      saveUnit: {
        finalizationId: row.id,
        saveUnitId: row.saveUnitId,
        saveUnitKind: row.saveUnitKind,
        revision: row.revision,
        planId: null,
        planItemId: null,
      },
    };
  }

  async function buildContext(
    scope: PreviewScope,
    selectedComponentIds: readonly string[],
    selectedUnattributedEntryIds: readonly string[],
    finalizationIds: readonly string[],
  ): Promise<CandidateBuildContext> {
    const resolvedFinalizations = [...new Set(finalizationIds)]
      .map(readFinalization)
      .filter((value): value is NonNullable<typeof value> => value !== null);
    const finalizations = resolvedFinalizations.map((value) => value.finalization);
    const effectiveMembers = finalizationIds.length === 0
      ? selectionMembers(scope, selectedComponentIds, selectedUnattributedEntryIds)
      : resolvePinnedSelectionDrift({
          repositoryKey: scope.context.repository.repositoryKey,
          inventory: scope.context.inventory,
          components: scope.context.components,
          finalizations,
          requestedComponentIds: selectedComponentIds,
          requestedUnattributedEntryIds: selectedUnattributedEntryIds,
        }).frozenEntries;
    const currentCommitReps = finalizationIds.length === 0
      ? new Map<string, CommitRepresentation>()
      : await resolveReps(scope, effectiveMembers);
    return {
      ...scope.context,
      finalizations,
      saveUnitFinalizations: resolvedFinalizations.map((value) => value.saveUnit),
      currentCommitReps,
    };
  }

  async function resolvePlanFinalizeRequest(
    planItemId: string,
  ): Promise<PlanFinalizeEnrichmentResult> {
    const pkg = getPlanWorkPackage(planItemId);
    if (!pkg) {
      return {
        ok: false,
        reason: 'plan-finalize-item-not-found',
        message: `Cannot mark ${planItemId} done because its work package no longer exists.`,
      };
    }

    let scope: PreviewScope;
    try {
      scope = await assembleScope(pkg.workspaceId);
    } catch (error) {
      return {
        ok: false,
        reason: 'plan-finalize-repository-unavailable',
        message: `Cannot mark ${planItemId} done because its repository is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const memberIds = new Set<string>();
    for (const component of scope.context.components) {
      for (const association of component.associations) {
        if (association.planId === pkg.planId && association.planItemId === pkg.id) {
          for (const entryId of association.memberEntryIds) memberIds.add(entryId);
        }
      }
    }
    const plannedPaths = new Set(listPlanWorkPackagePaths(pkg.id).map((entry) => entry.path));
    for (const entry of scope.context.inventory.entries) {
      const current = entry.path.utf8Clean ? entry.path.displayPath : null;
      const original = entry.originalPath?.utf8Clean ? entry.originalPath.displayPath : null;
      if ((current && plannedPaths.has(current)) || (original && plannedPaths.has(original))) {
        memberIds.add(entry.entryId);
      }
    }
    const members = [...memberIds]
      .map((entryId) => scope.entriesById.get(entryId))
      .filter((entry): entry is DirtyEntry => entry !== undefined)
      .map((entry): CommitRepresentationEntry => ({
        path: entry.path,
        commitPathspecs: entry.commitPathspecs,
        expectedWorktreeState: entry.expectedWorktreeState,
        rawWorktreeBlobOid: entry.rawWorktreeBlobOid,
      }));
    if (members.length === 0) {
      return {
        ok: false,
        reason: 'plan-finalize-members-unresolvable',
        message: `Cannot mark ${planItemId} done because no concrete dirty members resolve from its package stamps or planned paths.`,
      };
    }
    if (!deps.captureFinalizationBoundary) {
      return {
        ok: false,
        reason: 'plan-finalize-boundary-unavailable',
        message: `Cannot mark ${planItemId} done because checkpoint boundary capture is unavailable.`,
      };
    }

    let boundary: { oid: string; treeOid: string };
    try {
      boundary = await deps.captureFinalizationBoundary(
        pkg.workspaceId,
        `lares:finalization:plan-package:${planItemId}`,
      );
    } catch (error) {
      return {
        ok: false,
        reason: 'plan-finalize-boundary-unavailable',
        message: `Cannot mark ${planItemId} done because its checkpoint boundary could not be captured: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const request: FinalizePlanItemDoneRequest = {
      planItemId: pkg.id,
      repositoryKey: scope.context.repository.repositoryKey,
      boundaryOid: boundary.oid,
      members,
      checkpointTurnId: null,
      finalizedBy: 'human-ipc',
      createdFromWorkspaceId: pkg.workspaceId,
      contractVersion,
      repoRoot: scope.repoRoot,
      pinnedHeadOid: scope.pinnedHeadOid,
      gitExe,
    };
    return { ok: true, request };
  }

  return {
    async resolvePreviewContext(req: PlanCandidatePreviewRequest): Promise<CandidateBuildContext> {
      const scope = await assembleScope(req.workspaceId, true);
      const effectiveComponentIds = req.selectedComponentIds.length > 0
        ? req.selectedComponentIds
        : scope.context.components
            .filter((component) =>
              component.associations.some((association) => association.planId === req.planId),
            )
            .map((component) => component.componentId);
      return buildContext(
        scope,
        effectiveComponentIds,
        req.selectedUnattributedEntryIds,
        req.finalizationIds,
      );
    },
    resolveFinalizeRequest: resolvePlanFinalizeRequest,
  };
}
