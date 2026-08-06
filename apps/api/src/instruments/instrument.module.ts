import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';

import { InstrumentController } from './instrument.controller';
import { AdminInstrumentController } from './admin-instrument.controller';
import { InstrumentService } from './instrument.service';
import { InstrumentImportService } from './instrument-import.service';
import { InstrumentResolverService } from './instrument-resolver.service';
import { InstrumentStatsService } from './instrument-stats.service';

import { ZerodhaImporter } from './importers/zerodha.importer';
import { FyersImporter } from './importers/fyers.importer';
import { IciciImporter } from './importers/icici.importer';
import { ShoonyaImporter } from './importers/shoonya.importer';
import { InstrumentIntegrityService } from './instrument-integrity.service';

@Module({
  imports: [
    PrismaModule,
  ],
  controllers: [
    InstrumentController,
    AdminInstrumentController,
  ],
  providers: [
    InstrumentService,
    InstrumentImportService,
    InstrumentResolverService,
    InstrumentStatsService,
    InstrumentIntegrityService,
    ZerodhaImporter,
    FyersImporter,
    IciciImporter,
    ShoonyaImporter,
  ],
  exports: [
    InstrumentService,
    InstrumentImportService,
    InstrumentResolverService,
    InstrumentStatsService,
  ],
})
export class InstrumentModule {}