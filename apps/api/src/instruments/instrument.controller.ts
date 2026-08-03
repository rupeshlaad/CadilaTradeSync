import { Controller, Post } from '@nestjs/common';
import { ZerodhaImporter } from './importers/zerodha.importer';
import { FyersImporter } from './importers/fyers.importer';

@Controller('instruments')
export class InstrumentController {
  constructor(
    private readonly zerodhaImporter: ZerodhaImporter,
    private readonly fyersImporter: FyersImporter,
  ) {}

  @Post('import/zerodha')
  async importZerodha() {
    await this.zerodhaImporter.import();

    return {
      success: true,
      broker: 'ZERODHA',
    };
  }

  @Post('import/fyers')
  async importFyers() {
    await this.fyersImporter.import();

    return {
      success: true,
      broker: 'FYERS',
    };
  }

  @Post('import/all')
  async importAll() {

    await Promise.all([
      this.zerodhaImporter.import(),
      this.fyersImporter.import(),
    ]);

    return {
      success: true,
      message: 'All broker imports completed.',
    };
  }
}