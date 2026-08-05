import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { FollowerController } from './follower.controller';
import { FollowerService } from './follower.service';

@Module({
  imports: [PrismaModule],
  controllers: [FollowerController],
  providers: [FollowerService],
  exports: [FollowerService],
})
export class FollowerModule {}
