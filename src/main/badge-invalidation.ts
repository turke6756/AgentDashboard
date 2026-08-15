import { BrowserWindow } from 'electron';
import {
  PLAN_BADGES_INVALIDATED,
  type PlanBadgesInvalidatedPayload,
} from '../shared/types';

export const BADGE_INVALIDATION_QUIET_WINDOW_MS = 300;

export interface BadgeInvalidationScheduler<TTimer> {
  setTimeout(callback: () => void, delayMs: number): TTimer;
  clearTimeout(timer: TTimer): void;
}

export interface BadgeInvalidationCoordinatorOptions<TTimer> {
  scheduler: BadgeInvalidationScheduler<TTimer>;
  broadcast: (workspaceId: string) => void;
}

export interface BadgeInvalidationWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: PlanBadgesInvalidatedPayload): void;
  };
}

export function broadcastPlanBadgesInvalidated(
  workspaceId: string,
  getAllWindows: () => BadgeInvalidationWindow[] = () => BrowserWindow.getAllWindows(),
): void {
  const payload: PlanBadgesInvalidatedPayload = { workspaceId };
  for (const win of getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      try {
        win.webContents.send(PLAN_BADGES_INVALIDATED, payload);
      } catch {
        // Racy window disposal between the liveness checks and the send must
        // not abort delivery to the remaining live windows.
        console.warn('[badge-invalidation] push failed on a disposed window — suppressing');
      }
    }
  }
}

export class BadgeInvalidationCoordinator<TTimer> {
  private readonly timers = new Map<string, TTimer>();
  private stopped = false;

  constructor(private readonly options: BadgeInvalidationCoordinatorOptions<TTimer>) {}

  notify(workspaceId: string): void {
    if (this.stopped) return;

    const pending = this.timers.get(workspaceId);
    if (pending !== undefined) this.options.scheduler.clearTimeout(pending);

    const timer = this.options.scheduler.setTimeout(() => {
      this.timers.delete(workspaceId);
      if (!this.stopped) this.options.broadcast(workspaceId);
    }, BADGE_INVALIDATION_QUIET_WINDOW_MS);
    this.timers.set(workspaceId, timer);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers.values()) this.options.scheduler.clearTimeout(timer);
    this.timers.clear();
  }
}
