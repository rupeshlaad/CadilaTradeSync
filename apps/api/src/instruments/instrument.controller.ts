import { Controller, Post } from '@nestjs/common';
import { ZerodhaImporter } from './importers/zerodha.importer';
import { FyersImporter } from './importers/fyers.importer';
import { IciciImporter } from './importers/icici.importer';
import { ShoonyaImporter } from './importers/shoonya.importer';

@Controller('instruments')
export class InstrumentController {
  constructor(
    private readonly zerodhaImporter: ZerodhaImporter,
    private readonly fyersImporter: FyersImporter,
    private readonly iciciImporter: IciciImporter,
    private readonly shoonyaImporter: ShoonyaImporter,
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

  @Post('import/icici')
  async importIcici() {
    await this.iciciImporter.import();

    return {
      success: true,
      broker: 'ICICI_DIRECT',
    };
  }

  @Post('import/shoonya')
  async importShoonya() {
    await this.shoonyaImporter.import();

    return {
      success: true,
      broker: 'SHOONYA',
    };
  }

  @Post('import/all')
  async importAll() {

    await Promise.all([
      this.zerodhaImporter.import(),
      this.fyersImporter.import(),
      this.iciciImporter.import(),
      this.shoonyaImporter.import(),
    ]);

    return {
      success: true,
      message: 'All broker imports completed.',
    };
  }
}