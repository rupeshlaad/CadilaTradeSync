import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { FyersAdapter } from './fyers.adapter';
import { FyersService } from './fyers.service';

const loginStore = new Map<string, string>();

@Controller('brokers/fyers')
export class FyersController {
  private readonly adapter = new FyersAdapter();

  constructor(
    private readonly fyersService: FyersService,
  ) {}

  @Get('login')
  login(
    @Query('tradingAccountId') tradingAccountId: string,
    @Res() res: Response,
  ) {
    loginStore.set('current', tradingAccountId);

    return res.redirect(this.adapter.getLoginUrl());
  }

  @Get('callback')
  async callback(
    @Query('auth_code') authCode: string,
  ) {
    const session = await this.adapter.exchangeToken(authCode);

    const profile = await this.adapter.getProfile();

    const tradingAccountId = loginStore.get('current');

    if (!tradingAccountId) {
      throw new Error('Trading Account not found.');
    }

    loginStore.delete('current');

    await this.fyersService.saveSession(
      tradingAccountId,
      session,
      profile,
    );

    return {
      success: true,
      profile,
      accessToken: session.access_token,
    };
  }
}