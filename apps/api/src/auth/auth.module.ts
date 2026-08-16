import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthTokenService } from './tokens/auth-token.service';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { getJwtSecret, getJwtExpiresIn } from './jwt.config';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // No insecure fallback — fail fast if JWT_SECRET is missing/placeholder.
        secret: getJwtSecret(config),
        signOptions: { expiresIn: getJwtExpiresIn(config) },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy, AuthTokenService, RateLimitGuard],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
