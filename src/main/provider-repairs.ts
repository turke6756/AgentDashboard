import { codexWorkerProfileName } from '../shared/constants';

export function resolveCodexHookArtifactNames(isDev: boolean): {
  profileName: string;
  profileFile: string;
  statusScript: string;
  guardScript: string;
} {
  const suffix = isDev ? '-dev' : '';
  const profileName = codexWorkerProfileName(isDev);
  return {
    profileName,
    profileFile: `${profileName}.config.toml`,
    statusScript: `dashboard-status${suffix}.mjs`,
    guardScript: `guard-git-discard${suffix}.mjs`,
  };
}

export interface StartupProviderRepairDeps {
  isDev: boolean;
  validateWindows: () => void;
  validateWsl: () => void;
}

export function runStartupProviderRepairs({
  isDev,
  validateWindows,
  validateWsl,
}: StartupProviderRepairDeps): void {
  if (isDev) return;
  validateWindows();
  validateWsl();
}

export interface ProviderRepairWatcherDeps {
  isDev: boolean;
  startWatcher: () => void;
}

export function startProviderRepairWatcherIfOwner({
  isDev,
  startWatcher,
}: ProviderRepairWatcherDeps): void {
  if (isDev) return;
  startWatcher();
}
