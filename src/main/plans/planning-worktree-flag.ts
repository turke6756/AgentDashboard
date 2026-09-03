export const PLANNING_WORKTREES_ENV = 'LARES_PLANNING_WORKTREES';

export type EnvironmentReader = (name: string) => string | undefined;

/** Planning activity worktrees are experimental and must be explicitly enabled. */
export function planningWorktreesEnabled(
  readEnv: EnvironmentReader = (name) => process.env[name],
): boolean {
  return readEnv(PLANNING_WORKTREES_ENV) === '1';
}
