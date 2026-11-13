import type { RuleViolation } from '../../domain/document-events';
import type { CanonicalDocument } from '../../domain/invoice';
import type { DocumentType } from '../../domain/value-objects';

export interface StructureError {
  message: string;
  line?: number;
  column?: number;
}

export type StructureValidation =
  | { valid: true; documentType: DocumentType }
  | {
      valid: false;
      /**
       * not-well-formed: not parseable XML. doctype-forbidden: contains a DOCTYPE (XXE guard).
       * unsupported-document-type: a known document type we do not accept. Not used since
       * credit notes are accepted (ADR 0015); kept because it is part of the public API.
       * Any other root element is schema-invalid.
       * schema-invalid: fails the UBL 2.1 XSD.
       */
      reason:
        'not-well-formed' | 'doctype-forbidden' | 'unsupported-document-type' | 'schema-invalid';
      errors: StructureError[];
    };

/**
 * Synchronous structural check at intake (well-formedness, DOCTYPE ban, root element, UBL XSD).
 * Must never resolve external entities or fetch anything over the network.
 */
export abstract class StructureValidator {
  abstract validate(xml: Buffer): StructureValidation;
}

/**
 * Translates a structurally valid UBL invoice or credit note into our canonical model
 * (anti-corruption layer).
 */
export abstract class InvoiceMapper {
  abstract map(xml: Buffer): CanonicalDocument;
}

/**
 * Business rules (official EN 16931 + Peppol Schematron). CPU-heavy: runs in the worker, off the
 * event loop. Returns all violations; only `fatal` ones reject the document.
 */
export abstract class BusinessRuleValidator {
  abstract validate(xml: Buffer): Promise<RuleViolation[]>;
}
