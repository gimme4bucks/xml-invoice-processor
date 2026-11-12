import fs from 'node:fs';
import path from 'node:path';
import type { OnModuleDestroy } from '@nestjs/common';
import type { ErrorDetail, XmlDocument, XsdValidator } from 'libxml2-wasm';
import {
  type StructureError,
  type StructureValidation,
  StructureValidator,
} from '../../../application/ports';
import { type Libxml2, loadLibxml2, safeParseOptions } from './libxml2';
import { UBL_NAMESPACES, validationArtefactsDir } from './ubl';

/** Enough to fix a document; a broken 1 MB file would otherwise produce thousands of errors. */
const MAX_ERRORS = 50;

// Virtual paths under which the XSDs are handed to libxml2, so the relative
// `../common/X.xsd` imports of the main schema resolve from memory, never from disk or network.
const VIRTUAL_ROOT = '/ubl-2.1/';
const MAIN_SCHEMA = `${VIRTUAL_ROOT}maindoc/UBL-Invoice-2.1.xsd`;

/**
 * Synchronous intake check (ADR 0002): well-formedness, DOCTYPE ban, root element and the
 * official UBL 2.1 Invoice XSD. The schema is compiled once; a validation takes well under 1 ms.
 */
export class LibxmlStructureValidator extends StructureValidator implements OnModuleDestroy {
  private constructor(
    private readonly libxml: Libxml2,
    private readonly xsd: XsdValidator,
  ) {
    super();
  }

  static async create(artefactsDir = validationArtefactsDir()): Promise<LibxmlStructureValidator> {
    const libxml = await loadLibxml2();
    const xsdrt = path.join(artefactsDir, 'ubl-2.1', 'xsdrt');
    const buffers: Record<string, Uint8Array> = {};
    for (const dir of ['common', 'maindoc']) {
      for (const file of fs.readdirSync(path.join(xsdrt, dir))) {
        if (file.endsWith('.xsd')) {
          buffers[`${VIRTUAL_ROOT}${dir}/${file}`] = fs.readFileSync(path.join(xsdrt, dir, file));
        }
      }
    }
    const main = buffers[MAIN_SCHEMA];
    if (!main) throw new Error(`UBL Invoice schema not found under ${xsdrt}`);

    // The in-memory provider is only needed while the schema imports are resolved. Removing it
    // afterwards leaves nothing for an invoice to reach, even if a parse option were wrong.
    libxml.xmlRegisterInputProvider(new libxml.XmlBufferInputProvider(buffers));
    try {
      const schema = libxml.XmlDocument.fromBuffer(main, {
        url: MAIN_SCHEMA,
        option: safeParseOptions(libxml),
      });
      try {
        return new LibxmlStructureValidator(libxml, libxml.XsdValidator.fromDoc(schema));
      } finally {
        schema.dispose();
      }
    } finally {
      libxml.xmlCleanupInputProvider();
    }
  }

  validate(xml: Buffer): StructureValidation {
    let doc: XmlDocument;
    try {
      doc = this.libxml.XmlDocument.fromBuffer(xml, { option: safeParseOptions(this.libxml) });
    } catch (error) {
      if (error instanceof this.libxml.XmlParseError) {
        return invalid('not-well-formed', toStructureErrors(error.details));
      }
      throw error;
    }
    try {
      return this.check(doc);
    } finally {
      doc.dispose(); // WASM memory is not garbage-collected
    }
  }

  onModuleDestroy(): void {
    this.xsd.dispose();
  }

  private check(doc: XmlDocument): StructureValidation {
    // Any DOCTYPE, not only one that declares external entities: we never need one.
    if (doc.dtd) {
      return invalid('doctype-forbidden', [{ message: 'A DOCTYPE declaration is not allowed' }]);
    }
    const { name, namespaceUri } = doc.root;
    if (name === 'CreditNote' && namespaceUri === UBL_NAMESPACES.cn) {
      return invalid('unsupported-document-type', [
        { message: 'UBL CreditNote documents are not supported yet; only Invoice is accepted' },
      ]);
    }
    if (name !== 'Invoice' || namespaceUri !== UBL_NAMESPACES.ubl) {
      return invalid('schema-invalid', [
        {
          message: `The root element must be {${UBL_NAMESPACES.ubl}}Invoice, not {${namespaceUri}}${name}`,
          line: doc.root.line,
        },
      ]);
    }
    try {
      this.xsd.validate(doc);
    } catch (error) {
      if (error instanceof this.libxml.XmlValidateError) {
        return invalid('schema-invalid', toStructureErrors(error.details));
      }
      throw error;
    }
    return { valid: true, documentType: 'Invoice' };
  }
}

function invalid(
  reason: Extract<StructureValidation, { valid: false }>['reason'],
  errors: StructureError[],
): StructureValidation {
  return { valid: false, reason, errors };
}

function toStructureErrors(details: ErrorDetail[]): StructureError[] {
  const errors: StructureError[] = details
    .slice(0, MAX_ERRORS)
    .map((detail) => ({ message: detail.message.trim(), line: detail.line, column: detail.col }));
  if (details.length > MAX_ERRORS) {
    errors.push({ message: `${details.length - MAX_ERRORS} more error(s) omitted` });
  }
  return errors;
}
