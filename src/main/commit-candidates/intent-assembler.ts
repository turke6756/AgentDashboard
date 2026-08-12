import { createHash } from 'node:crypto';

import type { BundleCaptureHealth, DirtyInventory, ProtectionRung } from '../../shared/commit-candidates';
import type { SaveIntent } from '../database';
import type { ComponentAssembly } from './component-assembler';
import type { ProjectedWitness } from './witness-projection';
import { canonicalize } from './jcs';

export interface NamedSaveSetMember {
  intentId: string;
  entryId: string;
  pathBytesBase64: string;
  inventoryDigest: string;
}

export interface IntentConcurrencyEvidence {
  pathsWithMultipleIntents: string[];
}

export interface SaveIntentUnit {
  intent: SaveIntent;
  memberEntryIds: string[];
  contributingTurnIds: string[];
  contributingAgentIds: string[];
  topologyComponentIds: string[];
  concurrency: IntentConcurrencyEvidence;
  captureHealth: BundleCaptureHealth;
  weakestProtection: ProtectionRung | null;
}

export type FallbackUnitIdentityAssessment =
  | {
      evaluation: 'complete';
      agentId: string;
      sessionId: string | null;
      workspaceId: string;
      agentTitle: string;
    }
  | { evaluation: 'incomplete' };

export interface AgentSessionFallbackUnit {
  saveUnitId: string;
  saveUnitKind: 'agent-session-fallback';
  title: string;
  memberEntryIds: string[];
  contributingTurnIds: string[];
  identityAssessment: Extract<FallbackUnitIdentityAssessment, { evaluation: 'complete' }>;
  coarseIdentityWarning: boolean;
}

export interface IntentAssemblyInput {
  inventory: DirtyInventory;
  witnesses: ProjectedWitness[];
  intents: SaveIntent[];
  namedMembers: NamedSaveSetMember[];
  topology: ComponentAssembly;
}

export interface IntentAssembly {
  intentUnits: SaveIntentUnit[];
  fallbackUnits: AgentSessionFallbackUnit[];
  unwitnessedEntryIds: string[];
  legacyTaskIdentityUnavailableEntryIds: string[];
  witnessedUngroupableEntryIds: string[];
  staleNamedSaveSetIds: string[];
}

const emptyHealth = (): BundleCaptureHealth => ({
  turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [],
});

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** A2.4: app-owned agent/planning churn is outside fallback save tracking.
 * Explicit intent and named-set membership remain authoritative; this filter
 * only prevents legacy evidence from turning Lares' own machinery into units. */
function fallbackScopeEligible(displayPath: string): boolean {
  const normalized = displayPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const internalSegments = [
    '.lares/supervisor/',
    '.lares/workers/',
    '.lares/research/scratch/',
    '.lares/plans/',
    '.claude/skills/',
    '.agents/skills/',
  ];
  return !internalSegments.some((segment) =>
    normalized.startsWith(segment) || normalized.includes(`/${segment}`));
}

function fallbackUnitId(input: {
  repositoryKey: string;
  workspaceId: string;
  agentId: string;
  sessionId: string | null;
}): string {
  const digest = createHash('sha256').update(canonicalize({
    workspaceId: input.workspaceId,
    repositoryKey: input.repositoryKey,
    agentId: input.agentId,
    sessionKey: input.sessionId ?? 'legacy-null-session',
  })).digest('hex').slice(0, 16);
  return `agent-fallback:${input.repositoryKey}:${digest}`;
}

/** Pure intent projector: immutable witness and byte-addressed named membership
 * define units. Component connectivity contributes evidence links only. */
export function projectIntentUnits(input: IntentAssemblyInput): IntentAssembly {
  const entries = new Map(input.inventory.entries.map((entry) => [entry.entryId, entry]));
  const witnessesByEntry = new Map<string, ProjectedWitness[]>();
  for (const witness of input.witnesses) {
    if (!entries.has(witness.entryId)) continue;
    const list = witnessesByEntry.get(witness.entryId) ?? [];
    list.push(witness);
    witnessesByEntry.set(witness.entryId, list);
  }
  const componentsByEntry = new Map<string, string[]>();
  for (const component of input.topology.components) {
    for (const entryId of component.dirtyEntryIds) {
      const list = componentsByEntry.get(entryId) ?? [];
      list.push(component.componentId);
      componentsByEntry.set(entryId, list);
    }
  }

  const namedByIntent = new Map<string, string[]>();
  const namedMemberEntryIds = new Set<string>();
  const staleNamedSaveSetIds = new Set<string>();
  for (const member of input.namedMembers) {
    const entry = entries.get(member.entryId);
    if (member.inventoryDigest !== input.inventory.topologyDigest
      || !entry || entry.path.pathBytesBase64 !== member.pathBytesBase64) {
      staleNamedSaveSetIds.add(member.intentId);
      continue;
    }
    const list = namedByIntent.get(member.intentId) ?? [];
    list.push(member.entryId);
    namedByIntent.set(member.intentId, list);
    namedMemberEntryIds.add(member.entryId);
  }

  const intentUnits = input.intents.map((intent): SaveIntentUnit => {
    const intentWitnesses = input.witnesses.filter((witness) => witness.intentId === intent.id);
    const memberEntryIds = uniqueSorted([
      ...intentWitnesses.map((witness) => witness.entryId),
      ...(namedByIntent.get(intent.id) ?? []),
    ]);
    return {
      intent,
      memberEntryIds,
      contributingTurnIds: uniqueSorted(intentWitnesses.map((witness) => witness.turnId)),
      contributingAgentIds: uniqueSorted(intentWitnesses.flatMap((witness) =>
        witness.agentId === null ? [] : [witness.agentId])),
      topologyComponentIds: uniqueSorted(memberEntryIds.flatMap((entryId) =>
        componentsByEntry.get(entryId) ?? [])),
      concurrency: {
        pathsWithMultipleIntents: memberEntryIds.filter((entryId) => new Set(
          (witnessesByEntry.get(entryId) ?? []).flatMap((witness) =>
            witness.intentId === null ? [] : [witness.intentId]),
        ).size > 1),
      },
      captureHealth: emptyHealth(),
      weakestProtection: null,
    };
  }).filter((unit) => unit.memberEntryIds.length > 0 || staleNamedSaveSetIds.has(unit.intent.id))
    .sort((left, right) => left.intent.id.localeCompare(right.intent.id));

  const unwitnessedEntryIds: string[] = [];
  const legacyTaskIdentityUnavailableEntryIds: string[] = [];
  for (const entry of input.inventory.entries) {
    const witnesses = witnessesByEntry.get(entry.entryId) ?? [];
    if (witnesses.length === 0 && !namedMemberEntryIds.has(entry.entryId)) {
      unwitnessedEntryIds.push(entry.entryId);
    }
    else if (witnesses.every((witness) => witness.intentId === null)) {
      legacyTaskIdentityUnavailableEntryIds.push(entry.entryId);
    }
  }
  const legacyIds = new Set(legacyTaskIdentityUnavailableEntryIds);
  const witnessedUngroupableEntryIds = new Set<string>();
  const fallbackGroups = new Map<string, {
    workspaceId: string;
    agentId: string;
    sessionId: string | null;
    agentTitle: string;
    entryIds: Set<string>;
    turnIds: Set<string>;
  }>();
  for (const [entryId, witnesses] of witnessesByEntry) {
    if (!legacyIds.has(entryId)) continue;
    const entry = entries.get(entryId);
    if (!entry || !fallbackScopeEligible(entry.path.displayPath)) {
      witnessedUngroupableEntryIds.add(entryId);
      continue;
    }
    for (const witness of witnesses) {
      const agentTitle = witness.agentTitle?.trim() ?? '';
      if (!witness.agentId || witness.agentIdentityResolved !== true || !agentTitle
          || witness.sessionId === undefined) {
        witnessedUngroupableEntryIds.add(entryId);
        continue;
      }
      const key = `${witness.agentId}\0${witness.sessionId ?? 'legacy-null-session'}`;
      const existing = fallbackGroups.get(key);
      if (existing && existing.workspaceId !== witness.workspaceId) {
        witnessedUngroupableEntryIds.add(entryId);
        continue;
      }
      const group = existing ?? {
        workspaceId: witness.workspaceId,
        agentId: witness.agentId,
        sessionId: witness.sessionId,
        agentTitle,
        entryIds: new Set<string>(),
        turnIds: new Set<string>(),
      };
      group.entryIds.add(entryId);
      group.turnIds.add(witness.turnId);
      fallbackGroups.set(key, group);
    }
  }
  // A resolvable group wins over an unresolvable sibling witness. This keeps the
  // visible inventory a category partition while still allowing one entry to be
  // disclosed in multiple valid fallback units.
  for (const group of fallbackGroups.values()) {
    for (const entryId of group.entryIds) witnessedUngroupableEntryIds.delete(entryId);
  }
  const fallbackUnits = [...fallbackGroups.values()].map((group): AgentSessionFallbackUnit => {
    const coarseIdentityWarning = group.sessionId === null;
    return {
      saveUnitId: fallbackUnitId({
        repositoryKey: input.inventory.repository.repositoryKey,
        workspaceId: group.workspaceId,
        agentId: group.agentId,
        sessionId: group.sessionId,
      }),
      saveUnitKind: 'agent-session-fallback',
      title: `${group.agentTitle} — ${coarseIdentityWarning ? 'legacy agent-lifetime work' : 'mixed session work'}`,
      memberEntryIds: uniqueSorted(group.entryIds),
      contributingTurnIds: uniqueSorted(group.turnIds),
      identityAssessment: {
        evaluation: 'complete',
        agentId: group.agentId,
        sessionId: group.sessionId,
        workspaceId: group.workspaceId,
        agentTitle: group.agentTitle,
      },
      coarseIdentityWarning,
    };
  }).sort((left, right) => left.saveUnitId.localeCompare(right.saveUnitId));
  return {
    intentUnits,
    fallbackUnits,
    unwitnessedEntryIds: uniqueSorted(unwitnessedEntryIds),
    legacyTaskIdentityUnavailableEntryIds: uniqueSorted(legacyTaskIdentityUnavailableEntryIds),
    witnessedUngroupableEntryIds: uniqueSorted(witnessedUngroupableEntryIds),
    staleNamedSaveSetIds: uniqueSorted(staleNamedSaveSetIds),
  };
}
