import { createHash } from 'node:crypto';
import { z } from 'zod';
import { VatNumberVerifier, VatServiceUnavailableError } from '../../../application/ports';

export interface FakeViesOptions {
  /** Share of calls (0–1) that fail as "unavailable", decided by a hash, not by chance. */
  unavailableRate?: number;
  /** VAT numbers that VIES reports as not existing. */
  invalidVatNumbers?: string[];
  /** The first N calls for each VAT number fail as "unavailable", e.g. 2 = fails twice, then works. */
  unavailableTimesPerNumber?: number;
}

const envSchema = z.object({
  VIES_UNAVAILABLE_RATE: z.coerce.number().min(0).max(1).default(0),
  VIES_INVALID_VAT_NUMBERS: z.string().default(''),
  VIES_UNAVAILABLE_TIMES_PER_NUMBER: z.coerce.number().int().min(0).default(0),
});

/**
 * Stand-in for the EU VIES service ("peripheral systems may be mocked"). Deterministic, so a demo
 * or test can script it: per-number outages ("fails twice, then succeeds"), a fixed outage rate
 * and a list of non-existing numbers. Unavailability throws VatServiceUnavailableError, which
 * the worker retries with backoff; `invalid` fails the document permanently.
 *
 * The call counters live in memory, per process: a restart starts counting again.
 */
export class FakeViesVerifier extends VatNumberVerifier {
  private readonly unavailableRate: number;
  private readonly invalid: Set<string>;
  private readonly unavailableTimesPerNumber: number;
  private readonly calls = new Map<string, number>();

  constructor(options: FakeViesOptions = {}) {
    super();
    this.unavailableRate = options.unavailableRate ?? 0;
    this.invalid = new Set((options.invalidVatNumbers ?? []).map(normalise));
    this.unavailableTimesPerNumber = options.unavailableTimesPerNumber ?? 0;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): FakeViesVerifier {
    const config = envSchema.parse(env);
    return new FakeViesVerifier({
      unavailableRate: config.VIES_UNAVAILABLE_RATE,
      invalidVatNumbers: config.VIES_INVALID_VAT_NUMBERS.split(',').filter((n) => n.trim()),
      unavailableTimesPerNumber: config.VIES_UNAVAILABLE_TIMES_PER_NUMBER,
    });
  }

  async verify(vatNumber: string): Promise<'valid' | 'invalid'> {
    const number = normalise(vatNumber);
    const call = (this.calls.get(number) ?? 0) + 1;
    this.calls.set(number, call);

    // The messages never contain the VAT number: they end up in events and logs.
    if (call <= this.unavailableTimesPerNumber) {
      throw new VatServiceUnavailableError(
        `simulated outage (call ${call} of ${this.unavailableTimesPerNumber} for this number)`,
      );
    }
    if (fraction(`${number}#${call}`) < this.unavailableRate) {
      throw new VatServiceUnavailableError('simulated outage (VIES_UNAVAILABLE_RATE)');
    }
    return this.invalid.has(number) ? 'invalid' : 'valid';
  }
}

/** VIES ignores case, spaces and dots: `nl 0012.34567.B01` is `NL001234567B01`. */
function normalise(vatNumber: string): string {
  return vatNumber.replace(/[\s.]/g, '').toUpperCase();
}

/** A stable number in [0, 1) for the given input. */
function fraction(input: string): number {
  return createHash('sha256').update(input).digest().readUInt32BE(0) / 2 ** 32;
}
