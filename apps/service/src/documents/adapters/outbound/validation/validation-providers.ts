import type { Provider } from '@nestjs/common';
import { z } from 'zod';
import {
  BusinessRuleValidator,
  InvoiceMapper,
  StructureValidator,
  VatNumberVerifier,
} from '../../../application/ports';
import { FakeViesVerifier } from '../vies/fake-vies-verifier';
import { LibxmlStructureValidator } from './libxml-structure-validator';
import { SchematronBusinessRuleValidator } from './schematron-business-rule-validator';
import { UblInvoiceMapper } from './ubl-invoice-mapper';
import { validationArtifactsDir } from './ubl';

const envSchema = z.object({
  SCHEMATRON_POOL_SIZE: z.coerce.number().int().positive().default(2),
  SCHEMATRON_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

/**
 * The real validation adapters plus the VIES fake, for the composition root (G07). Settings come
 * from the environment:
 * - `VALIDATION_ARTIFACTS_DIR` (default `apps/service/validation-artifacts`);
 * - `SCHEMATRON_POOL_SIZE` (default 2) and `SCHEMATRON_TIMEOUT_MS` (default 30000);
 * - `VIES_UNAVAILABLE_RATE`, `VIES_INVALID_VAT_NUMBERS`, `VIES_UNAVAILABLE_TIMES_PER_NUMBER`.
 *
 * The SEFs from `build:validation` must exist, also for the API: it fails at startup otherwise.
 * The API never starts the Schematron thread pool, because it never validates business rules.
 */
export function validationProviders(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const config = envSchema.parse(env);
  const artifactsDir = validationArtifactsDir(env);
  return [
    {
      provide: StructureValidator,
      useFactory: () => LibxmlStructureValidator.create(artifactsDir),
    },
    { provide: InvoiceMapper, useFactory: () => UblInvoiceMapper.create() },
    {
      provide: BusinessRuleValidator,
      useFactory: () =>
        new SchematronBusinessRuleValidator({
          artifactsDir,
          poolSize: config.SCHEMATRON_POOL_SIZE,
          timeoutMs: config.SCHEMATRON_TIMEOUT_MS,
        }),
    },
    { provide: VatNumberVerifier, useFactory: () => FakeViesVerifier.fromEnv(env) },
  ];
}
