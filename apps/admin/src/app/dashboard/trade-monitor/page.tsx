'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Activity,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  Search,
} from 'lucide-react';

import {
  api,
  type ExecutionHistoryFollowerRow,
  type ExecutionHistoryListQuery,
  type ExecutionHistoryListResponse,
  type ExecutionHistoryRow,
  type ExecutionHistorySummary,
} from '@/lib/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'PARTIAL', label: 'Partial' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'NO_STRATEGY', label: 'No strategy' },
  { value: 'NO_FOLLOWERS', label: 'No followers' },
  { value: 'ERROR', label: 'Error' },
];

const BROKER_OPTIONS = [
  { value: '', label: 'All brokers' },
  { value: 'ZERODHA', label: 'Zerodha' },
  { value: 'FYERS', label: 'Fyers' },
  { value: 'SHOONYA', label: 'Shoonya' },
];

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'muted';

function statusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'COMPLETED':
      return 'success';
    case 'PARTIAL':
      return 'warning';
    case 'FAILED':
    case 'ERROR':
      return 'destructive';
    case 'NO_STRATEGY':
    case 'NO_FOLLOWERS':
      return 'muted';
    default:
      return 'outline';
  }
}

function followerStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'SUCCESS':
      return 'success';
    case 'FAILED':
      return 'destructive';
    case 'SKIPPED':
      return 'muted';
    case 'PENDING':
    case 'EXECUTING':
      return 'warning';
    default:
      return 'outline';
  }
}

function sideVariant(side: string): BadgeVariant {
  return side === 'BUY' ? 'success' : side === 'SELL' ? 'destructive' : 'outline';
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtMs(v: number | null | undefined) {
  if (v === null || v === undefined) return '—';
  if (v < 1000) return `${v} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function fmtNum(v: number | null | undefined) {
  return v === null || v === undefined ? '—' : v.toLocaleString();
}

function shortId(id: string | null | undefined, n = 8) {
  if (!id) return '—';
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

// ---------------------------------------------------------------------------
// Filters state
// ---------------------------------------------------------------------------

interface FiltersState {
  strategy: string;
  broker: string;
  symbol: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  search: string;
  sort: string;
  page: number;
}

const INITIAL_FILTERS: FiltersState = {
  strategy: '',
  broker: '',
  symbol: '',
  status: '',
  dateFrom: '',
  dateTo: '',
  search: '',
  sort: 'timestamp:desc',
  page: 1,
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TradeMonitorPage() {
  const [summary, setSummary] = useState<ExecutionHistorySummary | null>(null);
  const [list, setList] = useState<ExecutionHistoryListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FiltersState>(INITIAL_FILTERS);
  const [pendingFilters, setPendingFilters] = useState<FiltersState>(INITIAL_FILTERS);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [followerCache, setFollowerCache] = useState<
    Record<string, ExecutionHistoryFollowerRow[] | 'loading' | 'error'>
  >({});

  const load = useCallback(
    async (f: FiltersState) => {
      setRefreshing(true);
      setError(null);
      try {
        const query: ExecutionHistoryListQuery = {
          page: f.page,
          limit: PAGE_SIZE,
          strategy: f.strategy || undefined,
          broker: f.broker || undefined,
          symbol: f.symbol || undefined,
          status: f.status || undefined,
          dateFrom: f.dateFrom || undefined,
          dateTo: f.dateTo || undefined,
          search: f.search || undefined,
          sort: f.sort || undefined,
        };
        const [s, r] = await Promise.all([
          api.admin.executionHistory.summary(),
          api.admin.executionHistory.list(query),
        ]);
        setSummary(s);
        setList(r);
      } catch (e: any) {
        setError(e?.message ?? 'Failed to load execution history');
      } finally {
        setRefreshing(false);
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    load(filters);
  }, [filters, load]);

  const applyFilters = () => setFilters({ ...pendingFilters, page: 1 });
  const clearFilters = () => {
    setPendingFilters(INITIAL_FILTERS);
    setFilters(INITIAL_FILTERS);
  };
  const setPage = (p: number) => setFilters((prev) => ({ ...prev, page: p }));

  const toggleExpanded = async (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

    // Lazy-load followers once per row.
    if (!followerCache[id]) {
      setFollowerCache((prev) => ({ ...prev, [id]: 'loading' }));
      try {
        const detail = await api.admin.executionHistory.byId(id);
        setFollowerCache((prev) => ({ ...prev, [id]: detail.followers }));
      } catch {
        setFollowerCache((prev) => ({ ...prev, [id]: 'error' }));
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6" /> Trade Monitor
          </h2>
          <p className="text-muted-foreground">
            Permanent operational audit trail. Every master trade processed by
            the copy-trading service is stored with its follower results.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => load(filters)}
          disabled={refreshing}
          data-testid="trade-monitor-refresh-btn"
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      <SummaryCards summary={summary} />

      <FiltersPanel
        pending={pendingFilters}
        onChange={setPendingFilters}
        onApply={applyFilters}
        onClear={clearFilters}
      />

      {error && (
        <div
          className="text-sm text-destructive"
          data-testid="trade-monitor-error"
        >
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Executions</CardTitle>
          <CardDescription>
            Server-paginated, most recent first. Click a row to inspect the
            follower attempts; use the detail link for the full audit.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : !list || list.items.length === 0 ? (
            <div
              className="p-6 text-sm text-muted-foreground"
              data-testid="trade-monitor-empty"
            >
              No executions match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="w-8"></th>
                    <th className="text-left px-3 py-2">Time</th>
                    <th className="text-left px-3 py-2">Strategy</th>
                    <th className="text-left px-3 py-2">Master</th>
                    <th className="text-left px-3 py-2">Broker</th>
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-left px-3 py-2">Side</th>
                    <th className="text-right px-3 py-2">Qty</th>
                    <th className="text-right px-3 py-2">Followers</th>
                    <th className="text-right px-3 py-2">Success</th>
                    <th className="text-right px-3 py-2">Failed</th>
                    <th className="text-right px-3 py-2">Time</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="w-6"></th>
                  </tr>
                </thead>
                <tbody data-testid="trade-monitor-table-body">
                  {list.items.map((row) => (
                    <RowGroup
                      key={row.id}
                      row={row}
                      isOpen={expanded.has(row.id)}
                      followers={followerCache[row.id]}
                      onToggle={() => toggleExpanded(row.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {list && (
        <Pagination
          page={list.pagination.page}
          totalPages={list.pagination.totalPages}
          total={list.pagination.total}
          onPage={setPage}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

function SummaryCards({ summary }: { summary: ExecutionHistorySummary | null }) {
  const t = summary?.today;
  return (
    <div
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"
      data-testid="trade-monitor-summary"
    >
      <StatTile label="Today's trades" value={t?.trades ?? 0} />
      <StatTile
        label="Successful"
        value={t?.successful ?? 0}
        variant="success"
      />
      <StatTile
        label="Failed"
        value={t?.failed ?? 0}
        variant="destructive"
      />
      <StatTile
        label="Success %"
        value={t ? `${t.successPercent}%` : '—'}
        variant="secondary"
      />
      <StatTile
        label="Followers executed"
        value={t?.followersExecuted ?? 0}
        variant="secondary"
      />
      <StatTile
        label="Avg processing"
        value={fmtMs(t?.avgProcessingTimeMs ?? null)}
        variant="outline"
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  variant = 'default',
}: {
  label: string;
  value: number | string;
  variant?: BadgeVariant;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase text-muted-foreground">{label}</div>
        <div className="mt-2 flex items-center gap-2">
          <div className="text-2xl font-semibold">{value}</div>
          <Badge variant={variant} className="uppercase tracking-wide">
            {label}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function FiltersPanel({
  pending,
  onChange,
  onApply,
  onClear,
}: {
  pending: FiltersState;
  onChange: (next: FiltersState) => void;
  onApply: () => void;
  onClear: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Filters</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3"
          data-testid="trade-monitor-filters"
        >
          <FilterField label="Date from">
            <Input
              type="date"
              value={pending.dateFrom}
              onChange={(e) =>
                onChange({ ...pending, dateFrom: e.target.value })
              }
              data-testid="filter-date-from"
            />
          </FilterField>
          <FilterField label="Date to">
            <Input
              type="date"
              value={pending.dateTo}
              onChange={(e) =>
                onChange({ ...pending, dateTo: e.target.value })
              }
              data-testid="filter-date-to"
            />
          </FilterField>
          <FilterField label="Strategy">
            <Input
              placeholder="id or name"
              value={pending.strategy}
              onChange={(e) =>
                onChange({ ...pending, strategy: e.target.value })
              }
              data-testid="filter-strategy"
            />
          </FilterField>
          <FilterField label="Broker">
            <Select
              value={pending.broker}
              onChange={(e) =>
                onChange({ ...pending, broker: e.target.value })
              }
              data-testid="filter-broker"
            >
              {BROKER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField label="Symbol">
            <Input
              placeholder="e.g. NIFTY"
              value={pending.symbol}
              onChange={(e) =>
                onChange({ ...pending, symbol: e.target.value })
              }
              data-testid="filter-symbol"
            />
          </FilterField>
          <FilterField label="Status">
            <Select
              value={pending.status}
              onChange={(e) =>
                onChange({ ...pending, status: e.target.value })
              }
              data-testid="filter-status"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField label="Search">
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2 top-2.5 text-muted-foreground" />
              <Input
                className="pl-7"
                placeholder="symbol, email, order id…"
                value={pending.search}
                onChange={(e) =>
                  onChange({ ...pending, search: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onApply();
                }}
                data-testid="filter-search"
              />
            </div>
          </FilterField>
        </div>
        <div className="flex items-center gap-2 mt-4">
          <Button onClick={onApply} data-testid="filter-apply-btn">
            Apply
          </Button>
          <Button
            variant="outline"
            onClick={onClear}
            data-testid="filter-clear-btn"
          >
            Clear
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="text-xs uppercase text-muted-foreground">
        {label}
      </Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row + expandable follower detail
// ---------------------------------------------------------------------------

function RowGroup({
  row,
  isOpen,
  followers,
  onToggle,
}: {
  row: ExecutionHistoryRow;
  isOpen: boolean;
  followers: ExecutionHistoryFollowerRow[] | 'loading' | 'error' | undefined;
  onToggle: () => void;
}) {
  const Icon = isOpen ? ChevronDown : ChevronRight;
  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-t cursor-pointer transition-colors ${
          isOpen ? 'bg-accent' : 'hover:bg-accent/40'
        }`}
        data-testid={`trade-monitor-row-${row.id}`}
      >
        <td className="px-2 py-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </td>
        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
          {fmtTime(row.timestamp)}
        </td>
        <td className="px-3 py-2" title={row.strategyId ?? ''}>
          {row.strategyName ?? (
            <span className="text-muted-foreground italic">—</span>
          )}
        </td>
        <td className="px-3 py-2" title={row.masterAccountId}>
          {row.masterAccountName ?? shortId(row.masterAccountId)}
        </td>
        <td className="px-3 py-2">{row.masterBroker}</td>
        <td className="px-3 py-2 font-medium">{row.masterSymbol}</td>
        <td className="px-3 py-2">
          <Badge variant={sideVariant(row.masterSide)}>{row.masterSide}</Badge>
        </td>
        <td className="px-3 py-2 text-right">{row.masterQuantity}</td>
        <td className="px-3 py-2 text-right">{row.totalFollowers}</td>
        <td className="px-3 py-2 text-right text-emerald-600 dark:text-emerald-400">
          {row.successfulFollowers}
        </td>
        <td className="px-3 py-2 text-right text-destructive">
          {row.failedFollowers}
        </td>
        <td className="px-3 py-2 text-right text-muted-foreground">
          {fmtMs(row.processingTimeMs)}
        </td>
        <td className="px-3 py-2">
          <Badge variant={statusVariant(row.status)}>
            {row.status.replace(/_/g, ' ')}
          </Badge>
        </td>
        <td className="px-3 py-2 text-right">
          <Link
            href={`/dashboard/trade-monitor/${row.id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            data-testid={`trade-monitor-detail-link-${row.id}`}
          >
            Detail <ArrowUpRight className="h-3 w-3" />
          </Link>
        </td>
      </tr>
      {isOpen && (
        <tr
          className="border-t bg-muted/20"
          data-testid={`trade-monitor-detail-row-${row.id}`}
        >
          <td colSpan={14} className="px-6 py-4">
            <InlineDetail row={row} followers={followers} />
          </td>
        </tr>
      )}
    </>
  );
}

function InlineDetail({
  row,
  followers,
}: {
  row: ExecutionHistoryRow;
  followers: ExecutionHistoryFollowerRow[] | 'loading' | 'error' | undefined;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Master Trade</CardTitle>
          <CardDescription className="font-mono text-xs">
            {row.id}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <DetailRow label="Strategy" value={row.strategyName ?? '—'} />
          <DetailRow
            label="Master account"
            value={row.masterAccountName ?? row.masterAccountId}
          />
          <DetailRow label="Broker" value={row.masterBroker} />
          <DetailRow label="Symbol" value={row.masterSymbol} />
          <DetailRow
            label="Exchange / Segment"
            value={`${row.masterExchange ?? '—'} · ${row.masterSegment ?? '—'}`}
          />
          <DetailRow label="Side" value={row.masterSide} />
          <DetailRow label="Quantity" value={String(row.masterQuantity)} />
          <DetailRow
            label="Price"
            value={row.masterPrice === null ? '—' : String(row.masterPrice)}
          />
          <DetailRow label="Order type" value={row.orderType ?? '—'} />
          <DetailRow label="Product type" value={row.productType ?? '—'} />
          <DetailRow label="Trade source" value={row.tradeSource ?? '—'} />
          <DetailRow label="Time" value={fmtTime(row.timestamp)} />
          <DetailRow
            label="Processing time"
            value={fmtMs(row.processingTimeMs)}
          />
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">
            Follower Results ({row.totalFollowers})
          </CardTitle>
          <CardDescription>
            {fmtNum(row.successfulFollowers)} success · {fmtNum(row.failedFollowers)}{' '}
            failed · {fmtNum(row.skippedFollowers)} skipped
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {followers === undefined || followers === 'loading' ? (
            <div className="p-4 text-sm text-muted-foreground">
              Loading follower results…
            </div>
          ) : followers === 'error' ? (
            <div className="p-4 text-sm text-destructive">
              Failed to load follower results.
            </div>
          ) : followers.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No follower attempts were recorded for this execution.
            </div>
          ) : (
            <div className="divide-y">
              {followers.map((f) => (
                <FollowerCard key={f.id} follower={f} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FollowerCard({
  follower,
}: {
  follower: ExecutionHistoryFollowerRow;
}) {
  return (
    <div className="p-4 space-y-2">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="font-medium">
            {follower.followerEmail ?? follower.followerId ?? '—'}
          </div>
          <div className="text-xs text-muted-foreground">
            {follower.broker}
            {follower.followerSymbol && (
              <>
                {' · '}mapped{' '}
                <span className="font-mono">{follower.followerSymbol}</span>
              </>
            )}
            {follower.executedQuantity !== null && (
              <> {' · '}qty {follower.executedQuantity}</>
            )}
            {follower.brokerOrderId && (
              <>
                {' · '}order id{' '}
                <span className="font-mono">{follower.brokerOrderId}</span>
              </>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {follower.startedAt && (
              <>started {fmtTime(follower.startedAt)}</>
            )}
            {follower.completedAt && (
              <> · finished {fmtTime(follower.completedAt)}</>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant={followerStatusVariant(follower.status)}>
            {follower.status}
          </Badge>
          {follower.failureType && (
            <Badge variant="outline" className="text-xs uppercase">
              {follower.failureType.replace(/_/g, ' ')}
            </Badge>
          )}
        </div>
      </div>
      {follower.failureReason && (
        <div className="rounded-md border bg-muted/40 p-2 text-xs">
          <div className="text-muted-foreground uppercase tracking-wide text-[10px] mb-1">
            Failure reason
          </div>
          <div>{follower.failureReason}</div>
        </div>
      )}
      {follower.rawBrokerResponse !== null &&
        follower.rawBrokerResponse !== undefined && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Broker response
            </summary>
            <pre className="mt-2 rounded-md border bg-muted/40 p-2 overflow-x-auto text-[11px]">
              {formatResponse(follower.rawBrokerResponse)}
            </pre>
          </details>
        )}
    </div>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-40 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex-1 break-all">{value}</div>
    </div>
  );
}

function formatResponse(response: unknown): string {
  try {
    return typeof response === 'string'
      ? response
      : JSON.stringify(response, null, 2);
  } catch {
    return String(response);
  }
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const range = useMemo(() => buildPageRange(page, totalPages), [page, totalPages]);
  return (
    <div
      className="flex items-center justify-between gap-4 flex-wrap"
      data-testid="trade-monitor-pagination"
    >
      <div className="text-xs text-muted-foreground">
        Page {page} of {totalPages} · {total.toLocaleString()} execution(s)
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPage(Math.max(1, page - 1))}
          data-testid="page-prev"
        >
          Prev
        </Button>
        {range.map((p, i) =>
          p === '…' ? (
            <span
              key={`gap-${i}`}
              className="px-2 text-xs text-muted-foreground"
            >
              …
            </span>
          ) : (
            <Button
              key={p}
              variant={p === page ? 'default' : 'outline'}
              size="sm"
              onClick={() => onPage(p)}
              data-testid={`page-${p}`}
            >
              {p}
            </Button>
          ),
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          data-testid="page-next"
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function buildPageRange(page: number, totalPages: number): (number | '…')[] {
  const result: (number | '…')[] = [];
  const push = (n: number | '…') => {
    if (n === '…') {
      if (result[result.length - 1] === '…') return;
    }
    result.push(n);
  };
  const window = 2;
  for (let i = 1; i <= totalPages; i++) {
    if (
      i === 1 ||
      i === totalPages ||
      (i >= page - window && i <= page + window)
    ) {
      push(i);
    } else {
      push('…');
    }
  }
  return result;
}
