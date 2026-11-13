import { z } from 'zod';

/** When the worker looks for stuck documents (ADR 0014). */
export interface SweeperSettings {
  /** How often each worker sweeps. */
  intervalMs: number;
  /** A non-final document whose read model has not changed for this long is stuck. */
  stuckAfterMs: number;
}

export const SWEEPER_SETTINGS = Symbol('SweeperSettings');

/** Production-like: every minute, stuck after 15 minutes. */
export const DEFAULT_SWEEPER_SETTINGS: SweeperSettings = {
  intervalMs: 60_000,
  stuckAfterMs: 900_000,
};

const schema = z.object({
  SWEEPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_SWEEPER_SETTINGS.intervalMs),
  SWEEPER_STUCK_AFTER_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_SWEEPER_SETTINGS.stuckAfterMs),
});

/**
 * Reads SWEEPER_INTERVAL_MS and SWEEPER_STUCK_AFTER_MS. The threshold must exceed
 * `minimumStuckAfterMs`: a healthy document can stay unchanged that long (a retry delay plus a
 * slow Schematron run), and sweeping it would only add duplicate messages.
 */
export function loadSweeperSettings(
  env: NodeJS.ProcessEnv,
  minimumStuckAfterMs = 0,
): SweeperSettings {
  const parsed = schema.parse(env);
  if (parsed.SWEEPER_STUCK_AFTER_MS <= minimumStuckAfterMs) {
    throw new Error(
      `SWEEPER_STUCK_AFTER_MS (${parsed.SWEEPER_STUCK_AFTER_MS}) must exceed ${minimumStuckAfterMs} ms: ` +
        'the longest retry delay plus the Schematron timeout',
    );
  }
  return { intervalMs: parsed.SWEEPER_INTERVAL_MS, stuckAfterMs: parsed.SWEEPER_STUCK_AFTER_MS };
}
