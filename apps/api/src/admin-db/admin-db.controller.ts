import { Controller, Get, Param, Query } from '@nestjs/common';
import { Broker } from '@prisma/client';
import { AdminDbService } from './admin-db.service';

@Controller('admin-db')
export class AdminDbController {

  constructor(
    private readonly service: AdminDbService,
  ) {}

  @Get('summary')
  summary() {
    return this.service.summary();
  }

  @Get('broker-stats')
  brokerStats() {
    return this.service.brokerStats();
  }
  
  @Get('exchange-stats')
  exchangeStats() {
    return this.service.exchangeStats();
  }

  @Get("search/:symbol")
  search(
    @Param("symbol") symbol: string,
  ) {
    return this.service.search(symbol);
  }

  @Get('instrument')
  instrument(
    @Query('contractKey') contractKey: string,
  ) {
    return this.service.instrument(contractKey);
  }

  @Get('orphan-instruments')
  orphanInstruments() {
    return this.service.orphanInstruments();
  }

  @Get('missing-broker')
  missingBroker(
    @Query('broker') broker: Broker,
  ) {
    return this.service.missingBrokerMappings(broker);
  }
}