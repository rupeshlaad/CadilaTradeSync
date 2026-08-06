'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type AdminInstrumentSearchRow,
  type AdminInstrumentResolved,
  type AdminInstrumentTranslateResponse,
  type AdminInstrumentImportSummary,
  type AdminInstrumentStatsResponse,
  type AdminInstrumentIntegrityReport,
} from '@/lib/api';
import { Broker, BROKER_LABELS, ACTIVE_BROKERS } from '@cts/shared';
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
  Copy,
  Check,
  Database,
  Link2,
  Repeat,
  Clock,
} from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

type ImportKey = 'ZERODHA' | 'FYERS' | 'ICICI_DIRECT' | 'SHOONYA' | 'ALL';

const EXCHANGE_OPTIONS = ['', 'NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'];
const SEGMENT_OPTIONS = ['', 'NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'];
const INSTRUMENT_TYPE_OPTIONS = ['', 'EQ', 'FUT', 'CE', 'PE', 'IDX'];

function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function formatDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec} sec`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function formatCount(n: number | null | undefined) {
  if (n == null) return '—';
  return n.toLocaleString();
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
    ICICI_DIRECT: false,
    SHOONYA: false,
    ALL: false,
  });
  const [importSummaries, setImportSummaries] = useState<
    Partial<Record<Broker, AdminInstrumentImportSummary>>
  >({});

  // -------- Stats --------
  const [stats, setStats] = useState<AdminInstrumentStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const s = await api.admin.instruments.stats();
      setStats(s);
      // Seed importSummaries from persisted-per-process history so a page
      // reload during an idle window still shows the most recent outcome.
      if (s.lastSummaries) {
        setImportSummaries((prev) => ({
          ...s.lastSummaries,
          ...prev,
        }));
      }
    } catch (e: any) {
      setStatsError(e?.message ?? 'Failed to load stats');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Translate section — refs used to auto-focus the source-symbol input
  // when a user clicks "Translate" on a search row so the workflow is
  // continuous instead of requiring manual typing.
  const translateSectionRef = useRef<HTMLDivElement | null>(null);
  const translateSymbolInputRef = useRef<HTMLInputElement | null>(null);

  async function runImportOne(b: Broker) {
    const key = b as ImportKey;
    setImportBusy((s) => ({ ...s, [key]: true }));
    try {
      const res = await api.admin.instruments.importOne(b);
      setImportSummaries((prev) => ({ ...prev, [b]: res.summary }));
      pushToast({
        kind: 'success',
        title: `${BROKER_LABELS[b]} import complete`,
        message: `Inserted ${res.summary.inserted.toLocaleString()} · Updated ${res.summary.updated.toLocaleString()} · ${formatDuration(res.summary.durationMs)}`,
      });
      // Refresh current search results so the table reflects the new data.
      if (debouncedQ) runSearch();
      loadStats();
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
      const res = await api.admin.instruments.importAll();
      const merged: Partial<Record<Broker, AdminInstrumentImportSummary>> = {};
      for (const [broker, summary] of Object.entries(res.summaries ?? {})) {
        merged[broker as Broker] = summary;
      }
      setImportSummaries((prev) => ({ ...prev, ...merged }));
      const zTot = res.summaries?.[Broker.ZERODHA];
      const fTot = res.summaries?.[Broker.FYERS];
      const iTot = res.summaries?.[Broker.ICICI_DIRECT];
      const sTot = res.summaries?.[Broker.SHOONYA];
      const parts: string[] = [];
      if (zTot) parts.push(`Zerodha ${zTot.inserted + zTot.updated}`);
      if (fTot) parts.push(`Fyers ${fTot.inserted + fTot.updated}`);
      if (iTot) parts.push(`ICICI ${iTot.inserted + iTot.updated}`);
      if (sTot) parts.push(`Shoonya ${sTot.inserted + sTot.updated}`);
      pushToast({
        kind: 'success',
        title: 'All brokers refreshed',
        message: parts.join(' · ') || 'All broker instrument universes reloaded.',
      });
      if (debouncedQ) runSearch();
      loadStats();
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

  // -------- Clipboard --------
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyToClipboard = useCallback(
    async (value: string, label: string, key: string) => {
      if (!value) return;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        } else if (typeof document !== 'undefined') {
          const ta = document.createElement('textarea');
          ta.value = value;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        setCopiedKey(key);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopiedKey(null), 1500);
        pushToast({
          kind: 'info',
          title: `${label} copied`,
          message: value,
        });
      } catch (err: any) {
        pushToast({
          kind: 'error',
          title: `Failed to copy ${label}`,
          message: err?.message ?? 'Clipboard is unavailable.',
        });
      }
    },
    [pushToast],
  );

  // -------- Translate-from-row --------
  const translateFromRow = useCallback(
    (row: AdminInstrumentSearchRow) => {
      // Pre-fill: source broker + symbol come from the clicked row.
      // Target broker defaults to the other broker so the flow is
      // useful without further clicks.
      const source = row.broker;
      const target =
        source === Broker.ZERODHA ? Broker.FYERS : Broker.ZERODHA;
      setFromBroker(source);
      setFromSymbol(row.brokerSymbol);
      setToBroker(target);
      setTranslation(null);
      setTranslateError(null);
      // Scroll the translation card into view and focus the symbol input
      // so the "Translate" button is one keystroke away.
      requestAnimationFrame(() => {
        translateSectionRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
        translateSymbolInputRef.current?.focus();
      });
    },
    [],
  );

  const anyImportRunning =
    importBusy.ZERODHA ||
    importBusy.FYERS ||
    importBusy.ICICI_DIRECT ||
    importBusy.SHOONYA ||
    importBusy.ALL;
  const runningBrokerLabel = importBusy.ALL
    ? 'All brokers'
    : importBusy.ZERODHA
    ? BROKER_LABELS[Broker.ZERODHA]
    : importBusy.FYERS
    ? BROKER_LABELS[Broker.FYERS]
    : importBusy.ICICI_DIRECT
    ? BROKER_LABELS[Broker.ICICI_DIRECT]
    : importBusy.SHOONYA
    ? BROKER_LABELS[Broker.SHOONYA]
    : null;

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
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Import in Progress
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                Import Zerodha
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => runImportOne(Broker.FYERS)}
            disabled={importBusy.FYERS || importBusy.ALL}
            data-testid="import-fyers-btn"
          >
            {importBusy.FYERS ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Import in Progress
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                Import Fyers
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => runImportOne(Broker.ICICI_DIRECT)}
            disabled={importBusy.ICICI_DIRECT || importBusy.ALL}
            data-testid="import-icici-btn"
          >
            {importBusy.ICICI_DIRECT ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Import in Progress
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                Import ICICI
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => runImportOne(Broker.SHOONYA)}
            disabled={importBusy.SHOONYA || importBusy.ALL}
            data-testid="import-shoonya-btn"
          >
            {importBusy.SHOONYA ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Import in Progress
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                Import Shoonya
              </>
            )}
          </Button>
          <Button
            onClick={runImportAll}
            disabled={anyImportRunning}
            data-testid="import-refresh-all-btn"
          >
            {importBusy.ALL ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Import in Progress
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4" />
                Refresh All
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Running-import banner */}
      {anyImportRunning && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm flex items-center gap-3"
          role="status"
          data-testid="import-running-banner"
        >
          <Loader2 className="h-4 w-4 animate-spin text-amber-600 dark:text-amber-400" />
          <div className="flex-1">
            <span className="font-medium">Import in progress</span>
            {runningBrokerLabel && (
              <span className="text-muted-foreground"> · {runningBrokerLabel}</span>
            )}
            <span className="text-muted-foreground">
              {' '}· This can take a couple of minutes. The button is disabled to prevent duplicate imports.
            </span>
          </div>
        </div>
      )}

      {/* Statistics cards */}
      <div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5"
        data-testid="instrument-stats-cards"
      >
        <StatCard
          label="Canonical Instruments"
          value={formatCount(stats?.counts.canonical)}
          loading={statsLoading && !stats}
          icon={<Database className="h-4 w-4 text-muted-foreground" />}
          testId="stat-card-canonical"
        />
        <StatCard
          label="Broker Mappings"
          value={formatCount(stats?.counts.brokerMappings)}
          loading={statsLoading && !stats}
          icon={<Link2 className="h-4 w-4 text-muted-foreground" />}
          testId="stat-card-broker-mappings"
        />
        <StatCard
          label="Zerodha Instruments"
          value={formatCount(stats?.counts.zerodha)}
          loading={statsLoading && !stats}
          icon={<Badge variant="secondary">{BROKER_LABELS[Broker.ZERODHA]}</Badge>}
          testId="stat-card-zerodha"
        />
        <StatCard
          label="Fyers Instruments"
          value={formatCount(stats?.counts.fyers)}
          loading={statsLoading && !stats}
          icon={<Badge variant="secondary">{BROKER_LABELS[Broker.FYERS]}</Badge>}
          testId="stat-card-fyers"
        />
        <StatCard
          label="ICICI Instruments"
          value={formatCount(stats?.counts.icici)}
          loading={statsLoading && !stats}
          icon={<Badge variant="secondary">{BROKER_LABELS[Broker.ICICI_DIRECT]}</Badge>}
          testId="stat-card-icici"
        />
        <StatCard
          label="Shoonya Instruments"
          value={formatCount(stats?.counts.shoonya)}
          loading={statsLoading && !stats}
          icon={<Badge variant="secondary">{BROKER_LABELS[Broker.SHOONYA]}</Badge>}
          testId="stat-card-shoonya"
        />
        <StatCard
          label="Last Refresh"
          value={
            stats?.lastRefresh.overall ? formatDateTime(stats.lastRefresh.overall) : 'Never'
          }
          loading={statsLoading && !stats}
          icon={<Clock className="h-4 w-4 text-muted-foreground" />}
          testId="stat-card-last-refresh"
          small
        />
      </div>
      {statsError && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
          data-testid="stats-error"
        >
          Failed to load stats: {statsError}
        </div>
      )}

      {/* Import summaries */}
      {ACTIVE_BROKERS.some((b) => importSummaries[b]) && (
        <div
          className="grid gap-4 md:grid-cols-2"
          data-testid="import-summaries"
        >
          {ACTIVE_BROKERS.map((b) =>
            importSummaries[b] ? (
              <ImportSummaryCard key={b} summary={importSummaries[b]!} />
            ) : null,
          )}
        </div>
      )}

      {/* Instrument integrity (Sprint 6.2.5) */}
      <IntegrityPanel />

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
                  placeholder="Broker symbol, trading symbol, underlying or company name"
                  className="pl-9"
                  data-testid="instrument-search-input"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Matches broker symbol prefix and any substring of the underlying / company name.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Broker</Label>
              <Select
                value={broker}
                onChange={(e) => setBroker(e.target.value as '' | Broker)}
                data-testid="instrument-filter-broker"
              >
                <option value="">All brokers</option>
                {ACTIVE_BROKERS
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
                        <td className="py-3 pr-4 text-right whitespace-nowrap">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              translateFromRow(r);
                            }}
                            title="Translate this symbol to the other broker"
                            data-testid={`instrument-translate-${r.broker}-${r.brokerSymbol}`}
                          >
                            <Repeat className="h-4 w-4" /> Translate
                          </Button>
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
      <Card ref={translateSectionRef}>
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
                {ACTIVE_BROKERS
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
                ref={translateSymbolInputRef}
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
                {ACTIVE_BROKERS
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
                  <DetailField
                    label="Contract key"
                    value={
                      <div className="flex items-center gap-2">
                        <span className="font-mono break-all">
                          {detailsData.contractKey}
                        </span>
                        <CopyButton
                          value={detailsData.contractKey}
                          label="Contract key"
                          copyKey={`contract-key:${detailsData.contractKey}`}
                          copiedKey={copiedKey}
                          onCopy={copyToClipboard}
                          testId="copy-contract-key-btn"
                        />
                      </div>
                    }
                  />
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
                            <td className="py-2 px-3 font-mono text-xs">
                              <div className="flex items-center gap-2">
                                <span className="break-all">{b.brokerSymbol}</span>
                                <CopyButton
                                  value={b.brokerSymbol}
                                  label="Broker symbol"
                                  copyKey={`broker-symbol:${b.id}`}
                                  copiedKey={copiedKey}
                                  onCopy={copyToClipboard}
                                  testId={`copy-broker-symbol-${b.broker}-${b.brokerSymbol}`}
                                />
                              </div>
                            </td>
                            <td className="py-2 px-3 font-mono text-xs text-muted-foreground">
                              {b.brokerToken ? (
                                <div className="flex items-center gap-2">
                                  <span className="break-all">{b.brokerToken}</span>
                                  <CopyButton
                                    value={b.brokerToken}
                                    label="Broker token"
                                    copyKey={`broker-token:${b.id}`}
                                    copiedKey={copiedKey}
                                    onCopy={copyToClipboard}
                                    testId={`copy-broker-token-${b.broker}-${b.brokerSymbol}`}
                                  />
                                </div>
                              ) : (
                                '—'
                              )}
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

function StatCard({
  label,
  value,
  loading,
  icon,
  small,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  loading?: boolean;
  icon?: React.ReactNode;
  small?: boolean;
  testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-6 pb-5 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            {label}
          </div>
          {icon}
        </div>
        {loading ? (
          <div className="h-8 w-24 rounded-md bg-muted/60 animate-pulse" aria-hidden />
        ) : (
          <div
            className={small ? 'text-sm font-medium' : 'text-2xl font-semibold'}
            data-testid={testId ? `${testId}-value` : undefined}
          >
            {value}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ImportSummaryCard({ summary }: { summary: AdminInstrumentImportSummary }) {
  const total = summary.inserted + summary.updated + summary.skipped + summary.failed;
  const brokerKey = summary.broker;
  return (
    <Card data-testid={`import-summary-${brokerKey}`}>
      <CardContent className="pt-6 pb-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{BROKER_LABELS[brokerKey]}</Badge>
            <span className="text-sm font-medium">Last import summary</span>
          </div>
          {summary.failed > 0 ? (
            <Badge variant="warning">Partial</Badge>
          ) : (
            <Badge variant="success">OK</Badge>
          )}
        </div>
        <div className="grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
          <SummaryStat label="Downloaded" value={summary.downloaded.toLocaleString()} />
          <SummaryStat
            label="Inserted"
            value={summary.inserted.toLocaleString()}
            testId={`import-summary-${brokerKey}-inserted`}
          />
          <SummaryStat
            label="Updated"
            value={summary.updated.toLocaleString()}
            testId={`import-summary-${brokerKey}-updated`}
          />
          <SummaryStat
            label="Skipped"
            value={summary.skipped.toLocaleString()}
            testId={`import-summary-${brokerKey}-skipped`}
          />
          <SummaryStat
            label="Failed"
            value={summary.failed.toLocaleString()}
            emphasise={summary.failed > 0 ? 'destructive' : undefined}
            testId={`import-summary-${brokerKey}-failed`}
          />
          <SummaryStat label="Processed" value={total.toLocaleString()} />
        </div>
        <div className="pt-2 border-t text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>Duration: {formatDuration(summary.durationMs)}</span>
          <span>Last refresh: {formatDateTime(summary.finishedAt)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryStat({
  label,
  value,
  emphasise,
  testId,
}: {
  label: string;
  value: string;
  emphasise?: 'destructive';
  testId?: string;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`text-sm font-mono ${
          emphasise === 'destructive' ? 'text-destructive font-semibold' : ''
        }`}
        data-testid={testId}
      >
        {value}
      </div>
    </div>
  );
}

function CopyButton({
  value,
  label,
  copyKey,
  copiedKey,
  onCopy,
  testId,
}: {
  value: string;
  label: string;
  copyKey: string;
  copiedKey: string | null;
  onCopy: (value: string, label: string, key: string) => void;
  testId?: string;
}) {
  const copied = copiedKey === copyKey;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onCopy(value, label, copyKey);
      }}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
      data-testid={testId}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}


// ---------------------------------------------------------------------------
// Instrument Integrity (Sprint 6.2.5) — canonical ↔ broker-mapping validation
// ---------------------------------------------------------------------------

function IntegrityRow({
  label,
  ok,
  value,
}: {
  label: string;
  ok: boolean;
  value: string | number;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
      <span className="flex items-center gap-2">
        {ok ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        ) : (
          <AlertCircle className="h-4 w-4 text-destructive" />
        )}
        {label}
      </span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

function IntegrityPanel() {
  const [report, setReport] = useState<AdminInstrumentIntegrityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.admin.instruments.integrity();
      setReport(res);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load integrity report');
    } finally {
      setLoading(false);
    }
  }, []);

  const runFix = useCallback(async () => {
    setFixing(true);
    setError(null);
    try {
      const res = await api.admin.instruments.fixIntegrity();
      setReport(res.after);
    } catch (e: any) {
      setError(e?.message ?? 'Integrity fix failed');
    } finally {
      setFixing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card data-testid="instrument-integrity-panel">
      <CardContent className="pt-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold">Instrument Integrity</h3>
            {report &&
              (report.healthy ? (
                <Badge variant="success" data-testid="integrity-status">
                  Healthy
                </Badge>
              ) : (
                <Badge variant="destructive" data-testid="integrity-status">
                  Issues found
                </Badge>
              ))}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={load}
              disabled={loading || fixing}
              data-testid="integrity-refresh-btn"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Validate
            </Button>
            <Button
              size="sm"
              onClick={runFix}
              disabled={loading || fixing || (report?.healthy ?? false)}
              data-testid="integrity-fix-btn"
            >
              {fixing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Fixing…
                </>
              ) : (
                'Fix Issues'
              )}
            </Button>
          </div>
        </div>

        {error && (
          <div className="text-sm text-destructive" data-testid="integrity-error">
            {error}
          </div>
        )}

        {report && (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Counts
              </p>
              <IntegrityRow
                label="Canonical instruments"
                ok
                value={report.counts.canonical}
              />
              <IntegrityRow
                label="Broker mappings"
                ok
                value={report.counts.brokerMappings}
              />
              {ACTIVE_BROKERS.map((b) => (
                <IntegrityRow
                  key={b}
                  label={`${BROKER_LABELS[b]} mappings`}
                  ok
                  value={report.counts.perBroker?.[b] ?? 0}
                />
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Invariants &amp; Issues
              </p>
              <IntegrityRow
                label="Canonical = union of brokers"
                ok={report.invariants.canonicalEqualsUnion}
                value={report.invariants.canonicalEqualsUnion ? 'PASS' : 'FAIL'}
              />
              <IntegrityRow
                label="Mappings = sum of brokers"
                ok={report.invariants.brokerMappingsEqualsSum}
                value={report.invariants.brokerMappingsEqualsSum ? 'PASS' : 'FAIL'}
              />
              <IntegrityRow
                label="Duplicate mappings"
                ok={report.issues.duplicateMappings === 0}
                value={report.issues.duplicateMappings}
              />
              <IntegrityRow
                label="Missing canonical mappings"
                ok={report.issues.missingCanonicalMappings === 0}
                value={report.issues.missingCanonicalMappings}
              />
              <IntegrityRow
                label="Orphan instruments"
                ok={report.issues.orphanInstruments === 0}
                value={report.issues.orphanInstruments}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
