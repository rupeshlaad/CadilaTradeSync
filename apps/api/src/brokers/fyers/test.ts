import 'dotenv/config';
import { fyersModel } from 'fyers-api-v3';

const fyers = new fyersModel();

fyers.setAppId(process.env.FYERS_APP_ID!);
fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI!);

console.log(fyers.generateAuthCode());