export interface SweeperSettings {
  intervalMs: number;
  stuckAfterMs: number;
}

export const SWEEPER_SETTINGS = Symbol('SweeperSettings');

export const DEFAULT_SWEEPER_SETTINGS: SweeperSettings = {
  intervalMs: 60_000,
  stuckAfterMs: 900_000,
};

export function loadSweeperSettings(
  _env: NodeJS.ProcessEnv,
  _minimumStuckAfterMs = 0,
): SweeperSettings {
  throw new Error('loadSweeperSettings is not implemented yet');
}
