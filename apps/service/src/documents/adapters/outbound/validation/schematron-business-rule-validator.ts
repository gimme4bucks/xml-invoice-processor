import fs from 'node:fs';
import path from 'node:path';
import type { OnModuleDestroy } from '@nestjs/common';
import { Piscina } from 'piscina';
import type { RuleViolation } from '../../../domain/document-events';
import { BusinessRuleValidator } from '../../../application/ports';
import { toRuleViolations } from './svrl';
import type { SchematronWorkerData, SvrlFinding } from './schematron.worker';
import { validationArtifactsDir } from './ubl';

export interface SchematronOptions {
  artifactsDir?: string;
  /** Worker threads; each holds its own copy of both SEFs (about 100 MB or more). */
  poolSize?: number;
  /** Maximum run time of one invoice, both rule sets together. */
  timeoutMs?: number;
}

/** Rule id of the violation reported when an invoice does not finish within the timeout. */
export const TIMEOUT_RULE_ID = 'XIP-SCHEMATRON-TIMEOUT';

// From dist/ the worker is compiled JavaScript. From src/ (unit tests) it is TypeScript, which
// Node 22 runs with type stripping.
const FROM_SOURCE = __filename.endsWith('.ts');
const WORKER_FILE = path.join(__dirname, `schematron.worker.${FROM_SOURCE ? 'ts' : 'js'}`);
const WORKER_EXEC_ARGV = FROM_SOURCE
  ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
  : [];

/**
 * The official CEN EN 16931 and Peppol BIS 3.0 Schematron rules (ADR 0001), compiled to SEF by
 * `build:validation` and run by SaxonJS in a worker-thread pool (ADR 0002). SaxonJS is only
 * loaded inside the worker threads, and the pool starts on the first validation, so a process
 * that never validates (the API) pays nothing for it.
 */
export class SchematronBusinessRuleValidator
  extends BusinessRuleValidator
  implements OnModuleDestroy
{
  private readonly sefPaths: string[];
  private readonly poolSize: number;
  private readonly timeoutMs: number;
  private pool?: Piscina<string, SvrlFinding[]>;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(options: SchematronOptions = {}) {
    super();
    const generated = path.join(options.artifactsDir ?? validationArtifactsDir(), 'generated');
    this.sefPaths = ['cen-en16931-ubl.sef.json', 'peppol-en16931-ubl.sef.json'].map((file) =>
      path.join(generated, file),
    );
    const missing = this.sefPaths.filter((file) => !fs.existsSync(file));
    if (missing.length > 0) {
      throw new Error(
        `Schematron SEF(s) missing: ${missing.join(', ')}. Run: pnpm -F @xip/service build:validation`,
      );
    }
    this.poolSize = options.poolSize ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async validate(xml: Buffer): Promise<RuleViolation[]> {
    const findings = await this.withThread(() =>
      this.startPool().run(xml.toString('utf8'), { signal: AbortSignal.timeout(this.timeoutMs) }),
    ).catch((error: unknown) => {
      // Piscina terminates the thread that ran too long and starts a fresh one.
      if (error instanceof Error && error.name === 'AbortError') return 'timeout' as const;
      throw error;
    });
    if (findings === 'timeout') {
      // Permanent rather than retried: the same document would time out again.
      return [
        {
          ruleId: TIMEOUT_RULE_ID,
          flag: 'fatal',
          message: `Business rule validation did not finish within ${this.timeoutMs} ms`,
          location: '/ubl:Invoice[1]',
        },
      ];
    }
    return toRuleViolations(findings);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.destroy();
  }

  private startPool(): Piscina<string, SvrlFinding[]> {
    this.pool ??= new Piscina({
      filename: WORKER_FILE,
      execArgv: WORKER_EXEC_ARGV,
      workerData: { sefPaths: this.sefPaths } satisfies SchematronWorkerData,
      minThreads: this.poolSize,
      maxThreads: this.poolSize,
    });
    return this.pool;
  }

  /**
   * Hands a task to the pool only when a thread is free, so the timeout measures the run itself
   * and not the time spent queueing behind other invoices.
   */
  private async withThread<T>(task: () => Promise<T>): Promise<T> {
    while (this.running >= this.poolSize) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
