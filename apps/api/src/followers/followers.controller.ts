import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TermsGuard } from '../auth/guards/terms.guard';
import { FollowersService } from './followers.service';
import { SubscribeDto } from './dto/subscribe.dto';
import { UpdateFollowerDto } from './dto/update-follower.dto';

@Controller('followers')
@UseGuards(JwtAuthGuard)
export class FollowersController {
  constructor(private readonly service: FollowersService) {}

  @Get('my-strategies')
  listAsOwner(@Req() req: any) {
    return this.service.listMyFollowers(req.user.sub);
  }

  @Get('mine')
  listAsFollower(@Req() req: any) {
    return this.service.listWhereIFollow(req.user.sub);
  }

  @Post('subscribe')
  @UseGuards(TermsGuard)
  subscribe(@Req() req: any, @Body() dto: SubscribeDto) {
    return this.service.subscribe(req.user.sub, dto);
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateFollowerDto) {
    return this.service.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  unsubscribe(@Req() req: any, @Param('id') id: string) {
    return this.service.unsubscribe(req.user.sub, id);
  }
}
