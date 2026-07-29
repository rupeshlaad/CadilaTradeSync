import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { RedisService } from '../redis/redis.module';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check() {
    let db = 'down';
    let redis = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {}
    try {
      const pong = await this.redis.client.ping();
      redis = pong === 'PONG' ? 'up' : 'down';
    } catch {}
    return {
      status: db === 'up' && redis === 'up' ? 'ok' : 'degraded',
      services: { db, redis },
      timestamp: new Date().toISOString(),
    };
  }
}
