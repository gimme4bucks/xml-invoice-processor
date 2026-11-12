import { describe, expect, it } from 'vitest';
import { VatServiceUnavailableError } from '../../../application/ports';
import { FakeViesVerifier } from './fake-vies-verifier';

/** 'valid' | 'invalid', or 'unavailable' when the call threw VatServiceUnavailableError. */
async function outcome(vies: FakeViesVerifier, vatNumber: string): Promise<string> {
  try {
    return await vies.verify(vatNumber);
  } catch (error) {
    if (error instanceof VatServiceUnavailableError) return 'unavailable';
    throw error;
  }
}

async function outcomes(vies: FakeViesVerifier, vatNumber: string, times: number) {
  const results: string[] = [];
  for (let i = 0; i < times; i++) results.push(await outcome(vies, vatNumber));
  return results;
}

describe('FakeViesVerifier', () => {
  it('reports every number as valid by default', async () => {
    expect(await outcome(new FakeViesVerifier(), 'NL001234567B01')).toBe('valid');
  });

  it('reports configured numbers as invalid, ignoring case, spaces and dots', async () => {
    const vies = new FakeViesVerifier({ invalidVatNumbers: ['NL009876543B01'] });
    expect(await outcome(vies, 'nl 0098.76543.b01')).toBe('invalid');
    expect(await outcome(vies, 'NL001234567B01')).toBe('valid');
  });

  it('fails the first N calls per number, then answers ("fails twice, then succeeds")', async () => {
    const vies = new FakeViesVerifier({ unavailableTimesPerNumber: 2 });
    expect(await outcomes(vies, 'NL001234567B01', 3)).toEqual([
      'unavailable',
      'unavailable',
      'valid',
    ]);
    expect(await outcomes(vies, 'NL009876543B01', 3)).toEqual([
      'unavailable',
      'unavailable',
      'valid',
    ]);
  });

  it('never puts the VAT number in the error message', async () => {
    const vies = new FakeViesVerifier({ unavailableTimesPerNumber: 1 });
    await expect(vies.verify('NL001234567B01')).rejects.toThrow(
      expect.not.objectContaining({ message: expect.stringContaining('NL001234567B01') }) as Error,
    );
  });

  it.each([
    [0, 0],
    [1, 200],
  ])('with unavailable rate %d fails %d of 200 calls', async (rate, expected) => {
    const results = await outcomes(
      new FakeViesVerifier({ unavailableRate: rate }),
      'NL001234567B01',
      200,
    );
    expect(results.filter((r) => r === 'unavailable')).toHaveLength(expected);
  });

  it('applies a partial rate deterministically: same configuration, same answers', async () => {
    const run = () =>
      outcomes(new FakeViesVerifier({ unavailableRate: 0.5 }), 'NL001234567B01', 200);
    const first = await run();
    const unavailable = first.filter((r) => r === 'unavailable').length;
    expect(unavailable).toBeGreaterThan(60);
    expect(unavailable).toBeLessThan(140);
    expect(await run()).toEqual(first);
  });

  it('reads its configuration from the environment', async () => {
    const vies = FakeViesVerifier.fromEnv({
      VIES_INVALID_VAT_NUMBERS: 'NL009876543B01, BE0123456789',
      VIES_UNAVAILABLE_TIMES_PER_NUMBER: '1',
      VIES_UNAVAILABLE_RATE: '0',
    });
    expect(await outcomes(vies, 'BE0123456789', 2)).toEqual(['unavailable', 'invalid']);
    expect(await outcomes(vies, 'NL001234567B01', 2)).toEqual(['unavailable', 'valid']);
  });

  it('rejects an out-of-range rate', () => {
    expect(() => FakeViesVerifier.fromEnv({ VIES_UNAVAILABLE_RATE: '1.5' })).toThrow();
  });
});
