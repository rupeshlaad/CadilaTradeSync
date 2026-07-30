import { Body, Controller, Delete, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SubscriptionsService } from './subscriptions.service';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';

@Controller('subscriptions')
@UseGuards(JwtAuthGuard)
export class SubscriptionsController {
  constructor(private readonly service: SubscriptionsService) {}

  @Get()
  list(@Req() req: any) {
    return this.service.listMine(req.user.sub);
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateSubscriptionDto) {
    return this.service.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  cancel(@Req() req: any, @Param('id') id: string) {
    return this.service.cancel(req.user.sub, id);
  }
}
