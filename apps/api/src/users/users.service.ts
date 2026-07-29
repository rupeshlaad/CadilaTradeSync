import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { Role, User } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async create(data: { email: string; password: string; name?: string; role?: Role }) {
    return this.prisma.user.create({ data });
  }

  async listAll(): Promise<User[]> {
    return this.prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
  }

  toPublic(user: User) {
    const { password: _pw, ...safe } = user;
    return {
      ...safe,
      createdAt: safe.createdAt.toISOString(),
      updatedAt: safe.updatedAt.toISOString(),
    };
  }
}
