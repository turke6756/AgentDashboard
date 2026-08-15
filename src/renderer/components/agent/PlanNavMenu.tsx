import React, { useEffect, useRef, useState } from 'react';
import type { AgentPlanNavigation } from './useAgentPlanNavigation';

export default function PlanNavMenu({
  navigation,
  standalone = false,
  onRequestClose,
  returnFocusRef,
}: {
  navigation: AgentPlanNavigation;
  standalone?: boolean;
  onRequestClose?: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const { destinations } = navigation;
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const visible = standalone ? navigation.popover !== null : destinations.length > 0;
  const picker = standalone && navigation.pickerOpen;

  useEffect(() => {
    if (!standalone || !visible) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) navigation.dismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    if (!picker) {
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    }
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [navigation.dismiss, navigation.popover, picker, standalone, visible]);

  useEffect(() => {
    if (!picker) return;
    setFocusIndex(0);
    requestAnimationFrame(() => itemRefs.current[0]?.focus());
  }, [picker]);

  if (!visible) return null;

  const launchPicker = (opener: HTMLButtonElement) => {
    navigation.openPicker(opener, returnFocusRef?.current ?? undefined);
    onRequestClose?.();
  };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      navigation.dismiss();
      return;
    }
    if (!picker || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = itemRefs.current
      .map((item, index) => item && !item.disabled ? index : -1)
      .filter((index) => index >= 0);
    if (enabled.length === 0) return;
    const current = Math.max(0, enabled.indexOf(focusIndex));
    const next = event.key === 'Home' ? enabled[0]
      : event.key === 'End' ? enabled[enabled.length - 1]
        : event.key === 'ArrowDown' ? enabled[(current + 1) % enabled.length]
          : enabled[(current - 1 + enabled.length) % enabled.length];
    setFocusIndex(next);
    itemRefs.current[next]?.focus();
  };

  const rows = (destination: (typeof destinations)[number], index?: number) => {
    const disabledReason = navigation.reachability[destination.planArtifactId]?.proposalDisabledReason;
    return (
      <div key={destination.planArtifactId} className={picker ? 'border-b border-surface-3 py-1 last:border-b-0' : ''}>
        {picker && (
          <button
            ref={(element) => { if (index !== undefined) itemRefs.current[index * 2] = element; }}
            type="button"
            className="ui-menu-item font-semibold"
            tabIndex={index !== undefined && index * 2 === focusIndex ? 0 : -1}
            onFocus={() => { if (index !== undefined) setFocusIndex(index * 2); }}
            onClick={() => { onRequestClose?.(); void navigation.goToPlan(destination); }}
          >
            Go to plan — {destination.title}
          </button>
        )}
        {!picker && (
          <button type="button" className="ui-menu-item" onClick={() => { onRequestClose?.(); void navigation.goToPlan(destination); }}>
            Go to plan — {destination.title}
          </button>
        )}
        <button
          ref={(element) => { if (picker && index !== undefined) itemRefs.current[index * 2 + 1] = element; }}
          type="button"
          className="ui-menu-item"
          disabled={Boolean(disabledReason)}
          tabIndex={picker ? (index !== undefined && index * 2 + 1 === focusIndex ? 0 : -1) : undefined}
          onFocus={() => { if (picker && index !== undefined) setFocusIndex(index * 2 + 1); }}
          title={disabledReason}
          onClick={() => { onRequestClose?.(); void navigation.goToProposal(destination); }}
        >
          Go to proposal — {destination.title}
        </button>
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className={standalone ? 'ui-menu fixed z-[60] min-w-72' : 'border-t border-surface-3 mt-1 pt-1'}
      style={standalone && navigation.popover ? {
        left: navigation.popover.x,
        top: navigation.popover.y,
        maxHeight: 'min(20rem, calc(100vh - 16px))',
        overflowY: 'auto',
      } : undefined}
      role={standalone ? 'menu' : undefined}
      aria-label={picker ? 'Owned plans picker' : 'Plan navigation'}
      onKeyDown={keyDown}
      onBlur={(event) => {
        if (standalone && !event.currentTarget.contains(event.relatedTarget as Node | null)) navigation.dismiss();
      }}
    >
      <div className="ui-menu-header">Owned plans</div>
      {picker
        ? destinations.map((destination, index) => rows(destination, index))
        : destinations.length === 1
          ? rows(destinations[0])
          : (
            <button type="button" className="ui-menu-item" onClick={(event) => launchPicker(event.currentTarget)}>
              Plans ({destinations.length})…
            </button>
          )}
    </div>
  );
}
