'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type AdminInstrumentSearchRow,
  type AdminInstrumentResolved,
  type AdminInstrumentTranslateResponse,
} from '@/lib/api';
import { Broker, BROKER_LABELS } from '@cts/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Search,
  Download,
  RefreshCw,
  ArrowRight,
  ArrowDown,
  Info,
  CheckCircle2,
  AlertCircle,
  Loader2,
  X as XIcon,
} from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

type ImportKey = 'ZERODHA' | 'FYERS' | 'ALL';

const EXCHANGE_OPTIONS = ['', 'NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'];
const SEGMENT_OPTIONS = ['', 'NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'];
const INSTRUMENT_TYPE_OPTIONS = ['', 'EQ', 'FUT', 'CE', 'PE', 'IDX'];

function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function statusForRow(row: AdminInstrumentSearchRow) {
  if (row.brokerToken && row.brokerToken.length > 0) {
    return { label: 'Active', variant: 'success' as const };
  }
  return { label: 'Unmapped', variant: 'warning' as const };
}

export default function InstrumentsPage() {
  // -------- Toasts --------
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);
  const pushToast = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, ...t }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 4500);
  }, []);

  // -------- Search & filter state --------
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [broker, setBroker] = useState<'' | Broker>('');
  const [exchange, setExchange] = useState('');
  const [segment, setSegment] = useState('');
  const [instrumentType, setInstrumentType] = useState('');

  const [rows, setRows] = useState<AdminInstrumentSearchRow[]>([]);
  const [count, setCount] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchReqRef = useRef(0);

  // Debounce the free-text query only. Filters apply immediately.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(handle);
  }, [q]);

  const runSearch = useCallback(async () => {
    const query = debouncedQ;
    if (!query) {
      setRows([]);
      setCount(0);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    const myReq = ++searchReqRef.current;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await api.admin.instruments.search({
        q: query,
        broker: (broker || undefined) as Broker | undefined,
        exchange: exchange || undefined,
        segment: segment || undefined,
        instrumentType: instrumentType || undefined,
        limit: 50,
      });
      if (myReq !== searchReqRef.current) return; // stale
      setRows(res.items);
      setCount(res.count);
    } catch (e: any) {
      if (myReq !== searchReqRef.current) return;
      setSearchError(e?.message ?? 'Search failed');
      setRows([]);
      setCount(0);
    } finally {
      if (myReq === searchReqRef.current) setSearchLoading(false);
    }
  }, [debouncedQ, broker, exchange, segment, instrumentType]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  function clearFilters() {
    setBroker('');
    setExchange('');
    setSegment('');
    setInstrumentType('');
  }

  // -------- Details panel --------
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsData, setDetailsData] = useState<AdminInstrumentResolved | null>(null);
  const [detailsRow, setDetailsRow] = useState<AdminInstrumentSearchRow | null>(null);

  async function openDetails(row: AdminInstrumentSearchRow) {
    setDetailsRow(row);
    setDetailsOpen(true);
    setDetailsLoading(true);
    setDetailsError(null);
    setDetailsData(null);
    try {
      const res = await api.admin.instruments.resolve(row.instrument.contractKey);
      setDetailsData(res);
    } catch (e: any) {
      setDetailsError(e?.message ?? 'Failed to load instrument details');
    } finally {
      setDetailsLoading(false);
    }
  }

  // -------- Translation --------
  const [fromBroker, setFromBroker] = useState<Broker>(Broker.ZERODHA);
  const [fromSymbol, setFromSymbol] = useState('');
  const [toBroker, setToBroker] = useState<Broker>(Broker.FYERS);
  const [translating, setTranslating] = useState(false);
  const [translation, setTranslation] = useState<AdminInstrumentTranslateResponse | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);

  async function handleTranslate(e: React.FormEvent) {
    e.preventDefault();
    const sym = fromSymbol.trim();
    if (!sym) {
      setTranslateError('Enter a source symbol to translate.');
      return;
    }
    setTranslating(true);
    setTranslateError(null);
    setTranslation(null);
    try {
      const res = await api.admin.instruments.translate(fromBroker, sym, toBroker);
      setTranslation(res);
      pushToast({
        kind: 'success',
        title: 'Translation resolved',
        message: `${BROKER_LABELS[fromBroker]} ${sym} → ${BROKER_LABELS[toBroker]} ${res.target.brokerSymbol}`,
      });
    } catch (e: any) {
      const msg = e?.message ?? 'Translation failed';
      setTranslateError(msg);
      pushToast({ kind: 'error', title: 'Translation failed', message: msg });
    } finally {
      setTranslating(false);
    }
  }

  function swapBrokers() {
    setFromBroker(toBroker);
    setToBroker(fromBroker);
    if (translation) {
      setFromSymbol(translation.target.brokerSymbol);
      setTranslation(null);
    }
  }

  // -------- Imports --------
  const [importBusy, setImportBusy] = useState<Record<ImportKey, boolean>>({
    ZERODHA: false,
    FYERS: false,
    ALL: false,
  });

  async function runImportOne(b: Broker.ZERODHA | Broker.FYERS) {
    const key: ImportKey = b === Broker.ZERODHA ? 'ZERODHA' : 'FYERS';
    setImportBusy((s) => ({ ...s, [key]: true }));
    try {
      await api.admin.instruments.importOne(b);
      pushToast({
        kind: 'success',
        title: `${BROKER_LABELS[b]} import complete`,
        message: 'Instrument universe refreshed.',
      });
      // Refresh current search results so the table reflects the new data.
      if (debouncedQ) runSearch();
    } catch (e: any) {
      pushToast({
        kind: 'error',
        title: `${BROKER_LABELS[b]} import failed`,
        message: e?.message ?? 'Unknown error',
      });
    } finally {
      setImportBusy((s) => ({ ...s, [key]: false }));
    }
  }

  async function runImportAll() {
    setImportBusy((s) => ({ ...s, ALL: true }));
    try {
      await api.admin.instruments.importAll();
      pushToast({
        kind: 'success',
        title: 'All brokers refreshed',
        message: 'Zerodha and Fyers instrument universes reloaded.',
      });
      if (debouncedQ) runSearch();
    } catch (e: any) {
      pushToast({
        kind: 'error',
        title: 'Refresh all failed',
        message: e?.message ?? 'Unknown error',
      });
    } finally {
      setImportBusy((s) => ({ ...s, ALL: false }));
    }
  }

  // -------- Derived --------
  const hasQuery = debouncedQ.length > 0;
  const emptyStateMessage = useMemo(() => {
    if (!hasQuery) return 'Start typing a symbol or underlying above to search the instrument universe.';
    if (searchLoading) return null;
    return `No instruments matched "${debouncedQ}"${
      broker || exchange || segment || instrumentType ? ' with the applied filters' : ''
    }.`;
  }, [hasQuery, searchLoading, debouncedQ, broker, exchange, segment, instrumentType]);

  return (
    <div className="space-y-6" data-testid="instruments-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">Instruments</h2>
          <p className="text-muted-foreground">
            Search the canonical instrument catalogue, inspect broker mappings and refresh broker universes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" data-testid="instruments-import-actions">
          <Button
            variant="outline"
            onClick={() => runImportOne(Broker.ZERODHA)}
            disabled={importBusy.ZERODHA || importBusy.ALL}
            data-testid="import-zerodha-btn"
          >
            {importBusy.ZERODHA ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Import Zerodha
          </Button>
          <Button
            variant="outline"
            onClick={() => runImportOne(Broker.FYERS)}
            disabled={importBusy.FYERS || importBusy.ALL}
            data-testid="import-fyers-btn"
          >
            {importBusy.FYERS ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Import Fyers
          </Button>
          <Button
            onClick={runImportAll}
            disabled={importBusy.ALL || importBusy.ZERODHA || importBusy.FYERS}
            data-testid="import-refresh-all-btn"
          >
            {importBusy.ALL ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh All
          </Button>
        </div>
      </div>

      {/* Search + filters */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="grid gap-3 md:grid-cols-6">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="instrument-search">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  id="instrument-search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Symbol or underlying (e.g. RELIANCE)"
                  className="pl-9"
                  data-testid="instrument-search-input"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Broker</Label>
              <Select
                value={broker}
                onChange={(e) => setBroker(e.target.value as '' | Broker)}
                data-testid="instrument-filter-broker"
              >
                <option value="">All brokers</option>
                {Object.values(Broker)
                  .filter((b) => b === Broker.ZERODHA || b === Broker.FYERS)
                  .map((b) => (
                    <option key={b} value={b}>
                      {BROKER_LABELS[b]}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Exchange</Label>
              <Select
                value={exchange}
                onChange={(e) => setExchange(e.target.value)}
                data-testid="instrument-filter-exchange"
              >
                {EXCHANGE_OPTIONS.map((v) => (
                  <option key={v || 'all'} value={v}>
                    {v || 'All exchanges'}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Segment</Label>
              <Select
                value={segment}
                onChange={(e) => setSegment(e.target.value)}
                data-testid="instrument-filter-segment"
              >
                {SEGMENT_OPTIONS.map((v) => (
                  <option key={v || 'all'} value={v}>
                    {v || 'All segments'}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={instrumentType}
                onChange={(e) => setInstrumentType(e.target.value)}
                data-testid="instrument-filter-type"
              >
                {INSTRUMENT_TYPE_OPTIONS.map((v) => (
                  <option key={v || 'all'} value={v}>
                    {v || 'All types'}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              {searchLoading
                ? 'Searching…'
                : hasQuery
                ? `${count} result${count === 1 ? '' : 's'}`
                : 'Server-side filtering. Results are capped at 50.'}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                data-testid="instrument-clear-filters"
              >
                Clear filters
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results table */}
      <Card>
        <CardContent className="pt-6">
          {searchError ? (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
              data-testid="instruments-search-error"
              role="alert"
            >
              <div className="flex items-center gap-2 font-medium">
                <AlertCircle className="h-4 w-4" /> Search failed
              </div>
              <div className="mt-1 break-words">{searchError}</div>
            </div>
          ) : searchLoading ? (
            <div className="space-y-2" data-testid="instruments-loading">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-10 rounded-md bg-muted/60 animate-pulse"
                  aria-hidden
                />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div
              className="text-center py-12 text-muted-foreground text-sm"
              data-testid="instruments-empty-state"
            >
              {emptyStateMessage}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="instruments-table">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-3 pr-4">Broker Symbol</th>
                    <th className="py-3 pr-4">Trading Symbol</th>
                    <th className="py-3 pr-4">Underlying</th>
                    <th className="py-3 pr-4">Exchange</th>
                    <th className="py-3 pr-4">Segment</th>
                    <th className="py-3 pr-4">Type</th>
                    <th className="py-3 pr-4">Broker</th>
                    <th className="py-3 pr-4">Status</th>
                    <th className="py-3 pr-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const status = statusForRow(r);
                    return (
                      <tr
                        key={`${r.broker}:${r.brokerSymbol}:${r.instrument.id}`}
                        className="border-b last:border-none hover:bg-accent/30 cursor-pointer"
                        onClick={() => openDetails(r)}
                        data-testid={`instrument-row-${r.broker}-${r.brokerSymbol}`}
                      >
                        <td className="py-3 pr-4 font-medium font-mono text-xs">
                          {r.brokerSymbol}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs">
                          {r.instrument.exchange}:{r.brokerSymbol}
                        </td>
                        <td className="py-3 pr-4">{r.instrument.underlying}</td>
                        <td className="py-3 pr-4 text-xs text-muted-foreground">
                          {r.instrument.exchange}
                        </td>
                        <td className="py-3 pr-4 text-xs text-muted-foreground">
                          {r.instrument.segment}
                        </td>
                        <td className="py-3 pr-4">
                          <Badge variant="outline">{r.instrument.instrumentType}</Badge>
                        </td>
                        <td className="py-3 pr-4">
                          <Badge variant="secondary">{BROKER_LABELS[r.broker]}</Badge>
                        </td>
                        <td className="py-3 pr-4">
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </td>
                        <td className="py-3 pr-4 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              openDetails(r);
                            }}
                            data-testid={`instrument-view-${r.broker}-${r.brokerSymbol}`}
                          >
                            <Info className="h-4 w-4" /> Details
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Broker translation */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
            <div>
              <h3 className="text-lg font-semibold">Cross-broker translation</h3>
              <p className="text-sm text-muted-foreground">
                Resolve a source broker symbol to its equivalent on another broker via the canonical contract key.
              </p>
            </div>
          </div>

          <form
            onSubmit={handleTranslate}
            className="grid gap-3 md:grid-cols-[1fr_1fr_auto_1fr_auto] md:items-end"
            data-testid="translate-form"
          >
            <div className="space-y-1.5">
              <Label>Source broker</Label>
              <Select
                value={fromBroker}
                onChange={(e) => setFromBroker(e.target.value as Broker)}
                data-testid="translate-from-broker"
              >
                {Object.values(Broker)
                  .filter((b) => b === Broker.ZERODHA || b === Broker.FYERS)
                  .map((b) => (
                    <option key={b} value={b}>
                      {BROKER_LABELS[b]}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Source symbol</Label>
              <Input
                value={fromSymbol}
                onChange={(e) => setFromSymbol(e.target.value)}
                placeholder="e.g. RELIANCE"
                data-testid="translate-from-symbol"
              />
            </div>
            <div className="pb-2 hidden md:flex items-center justify-center text-muted-foreground">
              <ArrowRight className="h-4 w-4" />
            </div>
            <div className="space-y-1.5">
              <Label>Target broker</Label>
              <Select
                value={toBroker}
                onChange={(e) => setToBroker(e.target.value as Broker)}
                data-testid="translate-to-broker"
              >
                {Object.values(Broker)
                  .filter((b) => b === Broker.ZERODHA || b === Broker.FYERS)
                  .map((b) => (
                    <option key={b} value={b}>
                      {BROKER_LABELS[b]}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={swapBrokers}
                title="Swap source and target brokers"
                data-testid="translate-swap-btn"
              >
                Swap
              </Button>
              <Button type="submit" disabled={translating} data-testid="translate-submit-btn">
                {translating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                Translate
              </Button>
            </div>
          </form>

          <div className="mt-5">
            {translateError && !translating && (
              <div
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                data-testid="translate-error"
                role="alert"
              >
                {translateError}
              </div>
            )}

            {translation && !translateError && (
              <div
                className="rounded-md border bg-muted/30 p-4 space-y-3"
                data-testid="translate-result"
              >
                <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-center">
                  <div className="space-y-1">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Source</div>
                    <div className="font-mono text-sm">
                      <Badge variant="secondary" className="mr-2">
                        {BROKER_LABELS[translation.source.broker]}
                      </Badge>
                      <span data-testid="translate-source-symbol">
                        {translation.source.brokerSymbol}
                      </span>
                    </div>
                    {translation.source.brokerToken && (
                      <div className="text-xs text-muted-foreground font-mono">
                        token: {translation.source.brokerToken}
                      </div>
                    )}
                  </div>
                  <div className="hidden md:flex items-center justify-center text-muted-foreground">
                    <ArrowRight className="h-5 w-5" />
                  </div>
                  <div className="md:hidden flex items-center justify-center text-muted-foreground">
                    <ArrowDown className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Target</div>
                    <div className="font-mono text-sm">
                      <Badge variant="secondary" className="mr-2">
                        {BROKER_LABELS[translation.target.broker]}
                      </Badge>
                      <span data-testid="translate-target-symbol">
                        {translation.target.brokerSymbol}
                      </span>
                    </div>
                    {translation.target.brokerToken && (
                      <div className="text-xs text-muted-foreground font-mono">
                        token: {translation.target.brokerToken}
                      </div>
                    )}
                  </div>
                </div>
                <div className="pt-3 border-t text-xs text-muted-foreground">
                  Canonical instrument: <span className="font-mono">{translation.instrument.contractKey}</span>
                  {' · '}
                  {translation.instrument.underlying} · {translation.instrument.exchange} · {translation.instrument.instrumentType}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Details dialog */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent
          className="sm:max-w-2xl"
          data-testid="instrument-details-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              Instrument details
              {detailsRow && (
                <span className="ml-2 font-mono text-sm text-muted-foreground">
                  {detailsRow.instrument.exchange}:{detailsRow.brokerSymbol}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              Canonical row plus every broker mapping we hold for this contract.
            </DialogDescription>
          </DialogHeader>

          {detailsLoading ? (
            <div className="space-y-2 py-4" data-testid="instrument-details-loading">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-6 rounded-md bg-muted/60 animate-pulse" aria-hidden />
              ))}
            </div>
          ) : detailsError ? (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              data-testid="instrument-details-error"
              role="alert"
            >
              {detailsError}
            </div>
          ) : detailsData ? (
            <div className="space-y-5">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Canonical instrument
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <DetailField label="Contract key" value={detailsData.contractKey} mono />
                  <DetailField label="Underlying" value={detailsData.underlying} />
                  <DetailField label="Exchange" value={detailsData.exchange} />
                  <DetailField label="Segment" value={detailsData.segment} />
                  <DetailField label="Type" value={detailsData.instrumentType} />
                  <DetailField label="Expiry" value={formatDate(detailsData.expiry)} />
                  <DetailField
                    label="Strike"
                    value={detailsData.strike != null ? String(detailsData.strike) : '—'}
                  />
                  <DetailField label="Option" value={detailsData.optionType ?? '—'} />
                  <DetailField label="Lot size" value={String(detailsData.lotSize)} />
                  <DetailField
                    label="Tick size"
                    value={detailsData.tickSize != null ? String(detailsData.tickSize) : '—'}
                  />
                  <DetailField
                    label="Status"
                    value={
                      <Badge variant={detailsData.brokers.length > 0 ? 'success' : 'warning'}>
                        {detailsData.brokers.length > 0 ? 'Listed' : 'No broker mappings'}
                      </Badge>
                    }
                  />
                </div>
              </div>

              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Broker mappings ({detailsData.brokers.length})
                </div>
                {detailsData.brokers.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-3">
                    No broker mappings are registered for this instrument yet.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm" data-testid="instrument-details-brokers">
                      <thead>
                        <tr className="text-left text-muted-foreground border-b bg-muted/40">
                          <th className="py-2 px-3">Broker</th>
                          <th className="py-2 px-3">Broker Symbol</th>
                          <th className="py-2 px-3">Broker Token</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailsData.brokers.map((b) => (
                          <tr key={b.id} className="border-b last:border-none">
                            <td className="py-2 px-3">
                              <Badge variant="secondary">{BROKER_LABELS[b.broker]}</Badge>
                            </td>
                            <td className="py-2 px-3 font-mono text-xs">{b.brokerSymbol}</td>
                            <td className="py-2 px-3 font-mono text-xs text-muted-foreground">
                              {b.brokerToken ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Toasts */}
      <div
        className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-sm w-[calc(100%-2rem)] sm:w-96 pointer-events-none"
        aria-live="polite"
        data-testid="toast-region"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-md border shadow-lg p-3 text-sm bg-background flex items-start gap-2 ${
              t.kind === 'success'
                ? 'border-emerald-500/30'
                : t.kind === 'error'
                ? 'border-destructive/40'
                : 'border-border'
            }`}
            data-testid={`toast-${t.kind}`}
            role={t.kind === 'error' ? 'alert' : 'status'}
          >
            {t.kind === 'success' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
            ) : t.kind === 'error' ? (
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            ) : (
              <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium">{t.title}</div>
              {t.message && (
                <div className="text-xs text-muted-foreground break-words">{t.message}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              className="text-muted-foreground hover:text-foreground shrink-0"
              aria-label="Dismiss"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailField({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-sm ${mono ? 'font-mono break-all' : ''}`}>{value}</div>
    </div>
  );
}
