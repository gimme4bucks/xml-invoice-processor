import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../../../shared/auth/principal';

/** Liveness for the orchestrator: no token, no rate limit. */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  @Get()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
