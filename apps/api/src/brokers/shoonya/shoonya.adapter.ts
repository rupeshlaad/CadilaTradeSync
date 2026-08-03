import axios from 'axios';
import { BrokerAdapter, BrokerProfile } from '../broker.interface';

export class ShoonyaAdapter implements BrokerAdapter {
  private readonly baseUrl = 'https://api.shoonya.com/NorenWClientTP';
  private sessionToken = '';

  setSessionToken(token: string) {
    this.sessionToken = token;
  }

  getLoginUrl(): string {
    // Shoonya does not use OAuth like Zerodha/FYERS.
    // Login is handled using API credentials + TOTP.
    return '';
  }

  async exchangeToken(_: string): Promise<any> {
    throw new Error('Shoonya does not support OAuth token exchange.');
  }

  async login(payload: {
    uid: string;
    pwd: string;
    factor2: string;
    vc: string;
    appkey: string;
  }) {
    const body = new URLSearchParams();

    body.append(
      "jData",
      JSON.stringify({
        source: "API",
        apkversion: "1.0.0",
        uid: payload.uid,
        pwd: payload.pwd,
        factor2: payload.factor2,
        vc: payload.vc,
        appkey: payload.appkey,
        imei: "CTS_SERVER",
      }),
    );

    console.log(body.toString());

    const response = await axios.post(
      `${this.baseUrl}/QuickAuth`,
      body.toString(),
    );

    console.log(response.data);

    return response.data;
  }

  async getProfile(): Promise<BrokerProfile> {
    const { data } = await axios.post(
      `${this.baseUrl}/UserDetails`,
      {
        jKey: this.sessionToken,
      },
    );

    return {
      broker: 'SHOONYA',
      userId: data.actid,
      userName: data.uname,
      email: '',
    };
  }

  async getMargins() {
    return {};
  }

  async getHoldings() {
    return [];
  }

  async getPositions() {
    return [];
  }

  async placeOrder(order: any) {
    return {};
  }

  async modifyOrder(orderId: string, order: any) {
    return {};
  }

  async cancelOrder(orderId: string) {
    return {};
  }

  async getOrders() {
    return [];
  }
}