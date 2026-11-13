import { Injectable } from '@nestjs/common';
import type { SweepReport } from '../../../application/sweeper/stuck-document-sweeper';

@Injectable()
export class SweeperLoop {
  sweep(): Promise<SweepReport> {
    throw new Error('SweeperLoop is not implemented yet');
  }
}
