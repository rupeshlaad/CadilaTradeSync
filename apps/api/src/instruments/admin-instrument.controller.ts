import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Broker, Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

import { InstrumentService } from './instrument.service';
import { InstrumentResolverService } from './instrument-resolver.service';
import { InstrumentStatsService } from './instrument-stats.service';
import { ZerodhaImporter } from './importers/zerodha.importer';
import { FyersImporter } from './importers/fyers.importer';

import {
  LookupInstrumentDto,
  ManualInstrumentSearchDto,
  ResolveByContractKeyDto,
  SearchInstrumentsDto,
  TranslateInstrumentDto,
} from './dto/instruments.dto';

@Controller('admin/instruments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminInstrumentController {
  constructor(
    private readonly instrumentService: InstrumentService,
    private readonly resolver: InstrumentResolverService,
    private readonly zerodhaImporter: ZerodhaImporter,
    private readonly fyersImporter: FyersImporter,
    private readonly stats: InstrumentStatsService,
  ) {}

  /**
   * GET /admin/instruments/search
   *  ?q=RELIANCE            (required, min 1 char)
   *  &broker=ZERODHA|FYERS  (optional)
   *  &exchange=NSE|BSE|NFO  (optional)
   *  &segment=NSE|NFO       (optional)
   *  &instrumentType=EQ|CE|PE|FUT (optional)
   *  &limit=25              (optional, max 100)
   */
  @Get('search')
  async search(@Query() query: SearchInstrumentsDto) {
    const rows = await this.instrumentService.search({
      q: query.q,
      broker: query.broker,
      exchange: query.exchange,
      segment: query.segment,
      instrumentType: query.instrumentType,
      limit: query.limit,
    });
    return {
      count: rows.length,
      items: rows.map((r) => ({
        broker: r.broker,
        brokerSymbol: r.brokerSymbol,
        brokerToken: r.brokerToken,
        instrument: {
          id: r.instrument.id,
          contractKey: r.instrument.contractKey,
          exchange: r.instrument.exchange,
          segment: r.instrument.segment,
          underlying: r.instrument.underlying,
          instrumentType: r.instrument.instrumentType,
          expiry: r.instrument.expiry,
          strike: r.instrument.strike,
          optionType: r.instrument.optionType,
          lotSize: r.instrument.lotSize,
          tickSize: r.instrument.tickSize,
        },
      })),
    };
  }

  /**
   * GET /admin/instruments/manual-search
   *  ?broker=ZERODHA|FYERS|…   (required)
   *  &q=<query>                 (required, min 2 chars)
   *  &limit=20                  (optional, default 20, max 50)
   *
   * Sprint 5.4.1 — Powers the Manual Trading symbol autocomplete.
   * Broker-scoped and relevance-ranked (exact → prefix → contains).
   * The response shape is intentionally different from the generic
   * `/admin/instruments/search` endpoint: every field the picker
   * needs to pre-fill the order form (tradingSymbol, brokerSymbol,
   * displayName, exchange, segment, lotSize, tickSize, expiry,
   * strike, optionType) is included so no follow-up lookup is
   * required at selection time.
   */
  @Get('manual-search')
  async manualSearch(@Query() query: ManualInstrumentSearchDto) {
    const items = await this.instrumentService.searchForManualTrading({
      broker: query.broker,
      q: query.q,
      limit: query.limit,
    });
    return {
      broker: query.broker,
      q: query.q,
      count: items.length,
      items,
    };
  }

  /**
   * GET /admin/instruments/lookup?broker=ZERODHA&symbol=RELIANCE
   * Exact broker-symbol lookup. 404 if not present.
   */
  @Get('lookup')
  async lookup(@Query() query: LookupInstrumentDto) {
    const row = await this.instrumentService.findByBrokerSymbol(
      query.broker,
      query.symbol,
    );
    if (!row) {
      throw new NotFoundException(
        `No ${query.broker} instrument for symbol "${query.symbol}"`,
      );
    }
    return row;
  }

  /**
   * GET /admin/instruments/resolve?contractKey=NSE|RELIANCE
   * Returns the canonical Instrument row plus every broker mapping.
   */
  @Get('resolve')
  async resolve(@Query() query: ResolveByContractKeyDto) {
    const row = await this.resolver.resolveByContractKey(query.contractKey);
    if (!row) {
      throw new NotFoundException(
        `No instrument found for contractKey "${query.contractKey}"`,
      );
    }
    return row;
  }

  /**
   * GET /admin/instruments/translate
   *  ?fromBroker=ZERODHA&fromSymbol=RELIANCE&toBroker=FYERS
   * Cross-broker symbol translation via the canonical Instrument row.
   */
  @Get('translate')
  translate(@Query() query: TranslateInstrumentDto) {
    return this.resolver.translate(
      query.fromBroker,
      query.fromSymbol,
      query.toBroker,
    );
  }

  /**
   * GET /admin/instruments/:id/brokers
   * List every broker mapping for a given canonical instrument id.
   */
  @Get(':id/brokers')
  listBrokers(@Param('id') id: string) {
    return this.instrumentService.listBrokerSymbolsForInstrument(id);
  }

  /**
   * POST /admin/instruments/import/:broker
   * Admin-guarded trigger to refresh a broker's instrument universe.
   * (The legacy unauthenticated /instruments/import/* endpoints are
   * left in place for backward compatibility with existing tooling.)
   */
  @Post('import/:broker')
  async triggerImport(@Param('broker') broker: string) {
    const normalised = broker?.toUpperCase();
    if (normalised === Broker.ZERODHA) {
      const summary = await this.zerodhaImporter.import();
      return { success: true, broker: Broker.ZERODHA, summary };
    }
    if (normalised === Broker.FYERS) {
      const summary = await this.fyersImporter.import();
      return { success: true, broker: Broker.FYERS, summary };
    }
    throw new NotFoundException(
      `No importer registered for broker "${broker}"`,
    );
  }

  /**
   * POST /admin/instruments/import
   * Refresh every broker's instrument universe in parallel.
   */
  @Post('import')
  async triggerImportAll() {
    const [zerodha, fyers] = await Promise.all([
      this.zerodhaImporter.import(),
      this.fyersImporter.import(),
    ]);
    return {
      success: true,
      brokers: [Broker.ZERODHA, Broker.FYERS],
      summaries: { ZERODHA: zerodha, FYERS: fyers },
    };
  }

  /**
   * GET /admin/instruments/stats
   * Returns live DB counts, per-broker last refresh timestamps, and the
   * most recent import summary for each broker (in-memory since API boot).
   */
  @Get('stats')
  async getStats() {
    return this.stats.snapshot();
  }
}
