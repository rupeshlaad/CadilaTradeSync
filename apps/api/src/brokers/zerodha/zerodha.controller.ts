import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ZerodhaAdapter } from './zerodha.adapter';
import { ZerodhaService } from './zerodha.service';

const loginStore = new Map<string, string>();

@Controller('brokers/zerodha')
export class ZerodhaController {
  private readonly adapter = new ZerodhaAdapter();

  constructor(
    private readonly zerodhaService: ZerodhaService,
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
    @Query('request_token') requestToken: string,
  ) {
    const session = await this.adapter.exchangeToken(requestToken);
    const profile = await this.adapter.getProfile();

    const tradingAccountId = loginStore.get('current');

    if (!tradingAccountId) {
      throw new Error('Trading Account not found.');
    }

    loginStore.delete('current');

    await this.zerodhaService.saveSession(
      tradingAccountId,
      session,
      profile,
    );

    return {
      success: true,
      profile,
    };
  }
}