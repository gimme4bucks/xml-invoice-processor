import { describe, expect, it } from 'vitest';
import { requeueDelay } from '../../src/documents/adapters/outbound/rabbitmq/rabbitmq-config';

describe('requeueDelay', () => {
  const delay = { base: 1_000, max: 30_000 };

  it('doubles per earlier delivery', () => {
    expect([0, 1, 2, 3, 4].map((n) => requeueDelay(n, delay))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  it('is capped, so the delivery limit of 10 is reached after minutes instead of milliseconds', () => {
    expect(requeueDelay(5, delay)).toBe(30_000);
    expect(requeueDelay(9, delay)).toBe(30_000);
    const total = Array.from({ length: 10 }, (_, n) => requeueDelay(n, delay)).reduce(
      (a, b) => a + b,
    );
    expect(total).toBeGreaterThan(3 * 60_000);
  });

  it('treats a missing, malformed or negative count as the first delivery', () => {
    expect(requeueDelay(Number.NaN, delay)).toBe(1_000);
    expect(requeueDelay(-1, delay)).toBe(1_000);
  });
});
