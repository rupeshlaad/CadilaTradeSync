import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AcceptTermsDto } from './dto/accept-terms.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator';
import { UsersService } from '../users/users.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Post('register')
  @UseGuards(RateLimitGuard)
  @RateLimit({ keyPrefix: 'auth:register', limit: 5, windowSec: 3600 })
  async register(@Body() dto: RegisterDto) {
    return this.auth.register(dto.email, dto.password, dto.name);
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ keyPrefix: 'auth:login', limit: 10, windowSec: 900 })
  async login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: any) {
    const user = await this.users.findById(req.user.sub);
    return this.users.toPublic(user);
  }

  // ---------------- Email verification ----------------

  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @Post('resend-verification')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ keyPrefix: 'auth:resend-verification', limit: 5, windowSec: 3600 })
  async resendVerification(@Body() dto: ResendVerificationDto) {
    return this.auth.resendVerification(dto.email);
  }

  // ---------------- Forgot / Reset password ----------------

  @Post('forgot-password')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ keyPrefix: 'auth:forgot-password', limit: 5, windowSec: 3600 })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ keyPrefix: 'auth:reset-password', limit: 10, windowSec: 3600 })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  // ---------------- Change password (authenticated) ----------------

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(req.user.sub, dto.currentPassword, dto.newPassword);
  }

  // ---------------- Terms / consent ----------------

  @Get('terms')
  async terms() {
    return { version: this.auth.currentTermsVersion() };
  }

  @Post('accept-terms')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async acceptTerms(@Req() req: any, @Body() dto: AcceptTermsDto) {
    return this.auth.acceptTerms(req.user.sub, dto.version);
  }
}
