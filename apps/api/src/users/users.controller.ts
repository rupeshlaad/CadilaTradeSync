import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async me(@Req() req: any) {
    const user = await this.users.findById(req.user.sub);
    return this.users.toPublic(user);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  async listAll() {
    const users = await this.users.listAll();
    return users.map((u) => this.users.toPublic(u));
  }
}
