import type { RuleViolation } from '../../../domain/document-events';
import type { CanonicalInvoice } from '../../../domain/invoice';
import { PeppolParticipantId } from '../../../domain/value-objects';
import {
  BusinessRuleValidator,
  InvoiceMapper,
  StructureValidator,
  type StructureValidation,
  VatNumberVerifier,
  VatServiceUnavailableError,
} from '../../../application/ports';

// Stand-ins for the walking skeleton and unit tests only. The real adapters (libxml2-wasm XSD,
// SaxonJS Schematron, UBL mapper, VIES fake for demos) are built in work package G02.

/** Checks only the DOCTYPE ban and the root element; no XSD. */
export class StubStructureValidator extends StructureValidator {
  validate(xml: Buffer): StructureValidation {
    const text = xml.toString('utf8');
    if (/<!DOCTYPE/i.test(text)) {
      return {
        valid: false,
        reason: 'doctype-forbidden',
        errors: [{ message: 'DOCTYPE is not allowed' }],
      };
    }
    if (/<(\w+:)?CreditNote[\s>]/.test(text)) {
      return {
        valid: false,
        reason: 'unsupported-document-type',
        errors: [{ message: 'CreditNote documents are not supported yet' }],
      };
    }
    if (!/<(\w+:)?Invoice[\s>]/.test(text)) {
      return {
        valid: false,
        reason: 'schema-invalid',
        errors: [{ message: 'Root element must be Invoice' }],
      };
    }
    return { valid: true, documentType: 'Invoice' };
  }
}

/** Extracts just enough of a UBL invoice with regular expressions to drive the skeleton. */
export class StubInvoiceMapper extends InvoiceMapper {
  map(xml: Buffer): CanonicalInvoice {
    const text = xml.toString('utf8');
    const endpoints = [...text.matchAll(/<cbc:EndpointID schemeID="(\d{4})">([^<]+)</g)];
    const vats = [...text.matchAll(/<cac:PartyTaxScheme>\s*<cbc:CompanyID>([^<]+)</g)];
    const pick = (re: RegExp): string => re.exec(text)?.[1] ?? '';
    const party = (i: number) => {
      const endpoint = endpoints[i];
      if (!endpoint?.[1] || !endpoint[2]) throw new Error(`EndpointID #${i + 1} missing`);
      return {
        endpointId: PeppolParticipantId.parse(`${endpoint[1]}:${endpoint[2]}`),
        ...(vats[i]?.[1] ? { vatNumber: vats[i][1] } : {}),
      };
    };
    return {
      invoiceNumber: pick(/<cbc:ID>([^<]+)</),
      issueDate: pick(/<cbc:IssueDate>([^<]+)</),
      currency: pick(/<cbc:DocumentCurrencyCode>([^<]+)</),
      supplier: party(0),
      customer: party(1),
      lines: [],
      totals: {
        lineExtensionAmount: pick(/<cbc:LineExtensionAmount[^>]*>([^<]+)</),
        taxExclusiveAmount: pick(/<cbc:TaxExclusiveAmount[^>]*>([^<]+)</),
        taxAmount: pick(/<cbc:TaxAmount[^>]*>([^<]+)</),
        taxInclusiveAmount: pick(/<cbc:TaxInclusiveAmount[^>]*>([^<]+)</),
        payableAmount: pick(/<cbc:PayableAmount[^>]*>([^<]+)</),
      },
    };
  }
}

export class StubBusinessRuleValidator extends BusinessRuleValidator {
  violations: RuleViolation[] = [];

  async validate(): Promise<RuleViolation[]> {
    return this.violations;
  }
}

/** Scriptable VAT check: numbers in `invalid` are rejected; `failNext` calls throw as unavailable. */
export class ScriptedVatNumberVerifier extends VatNumberVerifier {
  readonly invalid = new Set<string>();
  failNext = 0;

  async verify(vatNumber: string): Promise<'valid' | 'invalid'> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new VatServiceUnavailableError('scripted outage');
    }
    return this.invalid.has(vatNumber) ? 'invalid' : 'valid';
  }
}
