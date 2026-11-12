import { randomUUID } from 'node:crypto';
import { Clock, IdGenerator } from '../../../application/ports';

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class RandomIdGenerator extends IdGenerator {
  newId(): string {
    return randomUUID();
  }
}
