// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PlanBadgeDestination } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentPlanBadges from './AgentPlanBadges';
import PlanNavMenu from './PlanNavMenu';
import { useAgentPlanNavigation } from './useAgentPlanNavigation';

let container: HTMLDivElement;
let root: Root;
const openTab = vi.fn();

function destination(id: string, title: string, proposalPath?: string): PlanBadgeDestination {
  return {
    kind: 'promoted-plan', planId: `row-${id}`, planArtifactId: id, title,
    relationships: ['carrying'], proposalPath,
  };
}

function Harness({ destinations }: { destinations: PlanBadgeDestination[] }) {
  const navigation = useAgentPlanNavigation(destinations);
  const embeddedReturnRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={embeddedReturnRef} type="button" data-testid="embedded-menu-trigger">Card menu trigger</button>
      <AgentPlanBadges navigation={navigation} />
      <div data-testid="parent-menu">
        <PlanNavMenu navigation={navigation} returnFocusRef={embeddedReturnRef} />
      </div>
      <PlanNavMenu navigation={navigation} standalone />
    </div>
  );
}

async function render(destinations: PlanBadgeDestination[]) {
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness destinations={destinations} />);
  });
}

function button(text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((item) => item.textContent === text);
  expect(result, text).toBeTruthy();
  return result!;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  (window as any).api = {
    plans: { documents: vi.fn(async () => ({ tabs: [{ key: 'overview' }] })) },
    files: { resolveOpenableWorkspacePath: vi.fn(async () => ({ ok: false, reason: 'missing' })) },
  };
  useDashboardStore.setState({
    selectedWorkspaceId: 'ws',
    workspaces: [{ id: 'ws', path: 'C:/ws', pathType: 'windows', title: 'WS' }],
    openPlanTab: vi.fn(async () => ({ kind: 'failed', reason: 'typed plan failure' })),
    openTab,
  } as any);
  openTab.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('agent plan navigation controller', () => {
  it('shares a menu failure with the card-local notice rendered by the badges', async () => {
    await render([destination('plan_00000001', 'One')]);
    await act(async () => { button('Go to plan — One').click(); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('typed plan failure');

    const chip = container.querySelector<HTMLElement>('[data-testid="agent-plan-badge"]')!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 18 }));
    });
    const popover = container.querySelector<HTMLElement>('[role="menu"]');
    expect(popover).toBeTruthy();
    const popoverPlan = Array.from(popover!.querySelectorAll<HTMLButtonElement>('button'))
      .find((item) => item.textContent === 'Go to plan — One')!;
    await act(async () => { popoverPlan.click(); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('typed plan failure');
  });

  it('normalizes duplicate artifact ids and roves picker focus with keyboard return', async () => {
    (window.api.plans.documents as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ tabs: [{ key: 'overview' }, { key: 'proposal' }] });
    const first = destination('plan_same0001', 'Canonical');
    const duplicate = { ...first, title: 'Duplicate row' };
    await render([first, duplicate, destination('plan_other001', 'Other'), destination('plan_third001', 'Third')]);
    expect(container.querySelectorAll('[data-testid="agent-plan-badge"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="agent-plan-overflow"]')?.textContent).toBe('+1');

    const overflow = container.querySelector<HTMLButtonElement>('[data-testid="agent-plan-overflow"]')!;
    await act(async () => { overflow.click(); });
    const picker = container.querySelector<HTMLElement>('[aria-label="Owned plans picker"]')!;
    expect(picker).toBeTruthy();
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(document.activeElement?.textContent).toBe('Go to plan — Canonical');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement?.textContent).toBe('Go to proposal — Canonical');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement?.textContent).toBe('Go to plan — Other');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.activeElement).toBe(overflow);
  });

  it('returns focus from the embedded Plans (N) row to the surviving card-menu trigger', async () => {
    await render([destination('plan_embed001', 'Embedded one'), destination('plan_embed002', 'Embedded two')]);
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="embedded-menu-trigger"]')!;
    await act(async () => { button('Plans (2)…').click(); });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(document.activeElement?.textContent).toBe('Go to plan — Embedded one');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.activeElement).toBe(trigger);
  });

  it('focuses a chip popover and returns picker focus to that surviving chip', async () => {
    await render([destination('plan_chip0001', 'Chip one'), destination('plan_chip0002', 'Chip two')]);
    const chip = container.querySelector<HTMLElement>('[data-testid="agent-plan-badge"]')!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 18 }));
    });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(document.activeElement?.textContent).toBe('Plans (2)…');
    const outside = container.querySelector<HTMLButtonElement>('[data-testid="embedded-menu-trigger"]')!;
    await act(async () => { outside.focus(); });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 18 }));
    });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(document.activeElement?.textContent).toBe('Go to plan — Chip one');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.activeElement).toBe(chip);
  });

  it('disables a statically unreachable proposal row with an explanatory tooltip', async () => {
    await render([destination('plan_00000002', 'No proposal')]);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const proposal = button('Go to proposal — No proposal');
    expect(proposal.disabled).toBe(true);
    expect(proposal.title).toBe('This plan has no proposal document.');
  });

  it('opens a canonical proposal file when the plan row is missing', async () => {
    (window.api.plans.documents as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (window.api.files.resolveOpenableWorkspacePath as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ ok: true, canonicalPath: 'C:/ws/canonical-proposal.md' });
    await render([destination('plan_00000003', 'Missing plan', 'C:/ws/source.md')]);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { button('Go to proposal — Missing plan').click(); });
    expect(openTab).toHaveBeenCalledWith(
      'C:/ws/canonical-proposal.md', 'C:/ws', 'windows', undefined, 'ws',
    );
  });

  it('surfaces a path failure discovered at invocation in the shared notice', async () => {
    (window.api.files.resolveOpenableWorkspacePath as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, canonicalPath: 'C:/ws/proposal.md' })
      .mockResolvedValueOnce({ ok: false, reason: 'missing' });
    await render([destination('plan_00000004', 'Disappearing proposal', 'C:/ws/proposal.md')]);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { button('Go to proposal — Disappearing proposal').click(); });
    expect(openTab).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Proposal file is missing.');
  });

  it('pins fallback-gallery and superseded outcome reasons to the card-local notice', async () => {
    const openPlan = vi.fn()
      .mockResolvedValueOnce({ kind: 'fallback-gallery', reason: 'opened fallback gallery' })
      .mockResolvedValueOnce({ kind: 'failed', reason: 'superseded by a newer request' });
    useDashboardStore.setState({ openPlanTab: openPlan } as any);
    await render([destination('plan_outcome1', 'Outcomes')]);
    await act(async () => { button('Go to plan — Outcomes').click(); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('opened fallback gallery');
    await act(async () => { button('Go to plan — Outcomes').click(); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('superseded by a newer request');
  });
});
