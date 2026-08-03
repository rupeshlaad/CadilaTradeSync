import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';

import { InstrumentController } from './instrument.controller';
import { InstrumentService } from './instrument.service';
import { InstrumentImportService } from './instrument-import.service';
import { InstrumentResolverService } from './instrument-resolver.service';

import { ZerodhaImporter } from './importers/zerodha.importer';
import { FyersImporter } from './importers/fyers.importer';

@Module({
  imports: [
    PrismaModule,
  ],
  controllers: [
    InstrumentController,
  ],
  providers: [
    InstrumentService,
    InstrumentImportService,
    InstrumentResolverService,
    ZerodhaImporter,
    FyersImporter,
  ],
  exports: [
    InstrumentService,
    InstrumentImportService,
    InstrumentResolverService,
  ],
})
export class InstrumentModule {}