import { Injectable } from '@nestjs/common';
import { BlobReferences } from './blob-references';
import { ObjectStore } from './object-store';

export interface OrphanReport {
  /** Objects old enough to be looked at. */
  examined: number;
  /** Of those, the ones no blob referenced, now deleted. */
  removed: number;
}

/**
 * Deletes objects that no blob references (ADR 0016): the upload of a unit of work that rolled
 * back, or of a process that died before its commit.
 */
@Injectable()
export class OrphanObjectCollector {
  constructor(
    private readonly objects: ObjectStore,
    private readonly references: BlobReferences,
  ) {}

  async collect(_writtenBefore: Date): Promise<OrphanReport> {
    throw new Error('Not implemented');
  }
}
