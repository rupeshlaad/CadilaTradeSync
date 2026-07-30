import 'dotenv/config';
import { KiteConnect } from 'kiteconnect';

console.log('API Key =', process.env.ZERODHA_API_KEY);

const kite: any = new KiteConnect({
  api_key: process.env.ZERODHA_API_KEY!,
});

console.log(kite.getLoginURL());