import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { peppolFixture, schematronArtefactsBuilt } from '../../../../../test/fixtures/peppol';
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
import { validationProviders } from './validation-providers';

describe.skipIf(!schematronArtefactsBuilt())('validationProviders', () => {
  it('binds the four ports to the real adapters and closes cleanly', async () => {
    const module = await Test.createTestingModule({
      providers: validationProviders({ VIES_INVALID_VAT_NUMBERS: 'NL009876543B01' }),
    }).compile();

    expect(module.get(StructureValidator)).toBeInstanceOf(LibxmlStructureValidator);
    expect(module.get(InvoiceMapper)).toBeInstanceOf(UblInvoiceMapper);
    expect(module.get(BusinessRuleValidator)).toBeInstanceOf(SchematronBusinessRuleValidator);
    expect(module.get(VatNumberVerifier)).toBeInstanceOf(FakeViesVerifier);
    expect(module.get(StructureValidator).validate(peppolFixture('valid-sales')).valid).toBe(true);
    expect(await module.get(VatNumberVerifier).verify('NL009876543B01')).toBe('invalid');

    await module.close();
  });

  it('rejects invalid settings at startup', () => {
    expect(() => validationProviders({ SCHEMATRON_POOL_SIZE: '0' })).toThrow();
  });
});
