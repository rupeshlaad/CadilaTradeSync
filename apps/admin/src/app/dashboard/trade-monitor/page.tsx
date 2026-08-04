'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Activity,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  MinusCircle,
} from 'lucide-react';

import {
  api,
  type ExecutionEvent,
  type ExecutionEventSummary,
  type ExecutionFollowerStatus,
  type FollowerExecution,
} from '@/lib/api';

// ---------------------------------------------------------------------------
// Formatting + badge helpers
// ---------------------------------------------------------------------------

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'muted';

function followerStatusVariant(s: ExecutionFollowerStatus): BadgeVariant {
  switch (s) {
    case 'SUCCESS':
      return 'success';
    case 'FAILED':
      return 'destructive';
    case 'PENDING':
    case 'EXECUTING':
      return 'warning';
    case 'SKIPPED':
      return 'muted';
    default:
      return 'outline';
  }
}

function outcomeVariant(outcome: ExecutionEvent['outcome']): BadgeVariant {
  switch (outcome) {
    case 'FANNED_OUT':
      return 'success';
    case 'NO_ACTIVE_STRATEGY':
    case 'NO_ENABLED_FOLLOWERS':
      return 'muted';
    case 'ERROR':
      return 'destructive';
    default:
      return 'outline';
  }
}

function sideVariant(side: 'BUY' | 'SELL'): BadgeVariant {
  return side === 'BUY' ? 'success' : 'destructive';
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function shortId(id: string | null | undefined, n = 8) {
  if (!id) return '—';
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

/**
 * A one-line rollup for the collapsed row: e.g. "3 of 5 SUCCESS · 1 FAILED".
 * Uses the same source-of-truth counters that the expanded row derives its
 * follower badges from.
 */
function followerRollup(event: ExecutionEvent) {
  const counts: Record<ExecutionFollowerStatus, number> = {
    PENDING: 0,
    EXECUTING: 0,
    SUCCESS: 0,
    FAILED: 0,
    SKIPPED: 0,
  };
  for (const f of event.followers) counts[f.status]++;
  const parts: string[] = [];
  if (counts.SUCCESS) parts.push(`${counts.SUCCESS} success`);
  if (counts.FAILED) parts.push(`${counts.FAILED} failed`);
  if (counts.PENDING || counts.EXECUTING)
    parts.push(`${counts.PENDING + counts.EXECUTING} pending`);
  if (counts.SKIPPED) parts.push(`${counts.SKIPPED} skipped`);
  return parts.length === 0
    ? `${event.followers.length} follower(s)`
    : parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TradeMonitorPage() {
  const [summary, setSummary] = useState<ExecutionEventSummary | null>(null);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const [s, r] = await Promise.all([
        api.admin.executionEvents.summary(),
        api.admin.executionEvents.recent(100),
      ]);
      setSummary(s);
      setEvents(r.items);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load execution events');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6" /> Trade Monitor
          </h2>
          <p className="text-muted-foreground">
            Operational view of the real copy-trading fan-out. One row per
            master trade processed by <code>CopyTradingService</code>.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={load}
          disabled={refreshing}
          data-testid="trade-monitor-refresh-btn"
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      {/* Today counters — all derived from the real execution buffer */}
      <div
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3"
        data-testid="trade-monitor-summary"
      >
        <SummaryCard
          label="Today's events"
          value={summary?.today.events ?? 0}
          hint={
            summary
              ? `${summary.bufferSize} of ${summary.bufferCapacity} in buffer`
              : undefined
          }
        />
        <SummaryCard
          label="Successful orders"
          value={summary?.today.successfulOrders ?? 0}
          variant="success"
        />
        <SummaryCard
          label="Failed orders"
          value={summary?.today.failedOrders ?? 0}
          variant="destructive"
        />
        <SummaryCard
          label="Pending orders"
          value={summary?.today.pendingOrders ?? 0}
          variant="warning"
        />
        <SummaryCard
          label="Followers executed"
          value={summary?.today.followersExecuted ?? 0}
          variant="secondary"
        />
      </div>

      {error && (
        <div
          className="text-sm text-destructive"
          data-testid="trade-monitor-error"
        >
          {error}
        </div>
      )}

      {/* Recent trades table */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Trades</CardTitle>
          <CardDescription>
            Most recent first. Click a row to expand the master trade and its
            follower results. Read-only — no execution controls.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : events.length === 0 ? (
            <div
              className="p-6 text-sm text-muted-foreground"
              data-testid="trade-monitor-empty"
            >
              No master trades have been processed yet by the copy-trading
              service.
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
                    <th className="text-left px-3 py-2">Product</th>
                    <th className="text-right px-3 py-2">Followers</th>
                    <th className="text-left px-3 py-2">Outcome</th>
                    <th className="text-left px-3 py-2">Result</th>
                  </tr>
                </thead>
                <tbody data-testid="trade-monitor-table-body">
                  {events.map((e) => {
                    const isOpen = expanded.has(e.id);
                    return (
                      <FragmentRow
                        key={e.id}
                        event={e}
                        isOpen={isOpen}
                        onToggle={() => toggle(e.id)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary tile
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  hint,
  variant = 'default',
}: {
  label: string;
  value: number | string;
  hint?: string;
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
        {hint && (
          <div className="text-xs text-muted-foreground mt-1">{hint}</div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Row + expandable detail
// ---------------------------------------------------------------------------

function FragmentRow({
  event,
  isOpen,
  onToggle,
}: {
  event: ExecutionEvent;
  isOpen: boolean;
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
        data-testid={`trade-monitor-row-${event.id}`}
      >
        <td className="px-2 py-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </td>
        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
          {fmtTime(event.timestamp)}
        </td>
        <td className="px-3 py-2" title={event.strategyId ?? ''}>
          {event.strategyName ?? (
            <span className="text-muted-foreground italic">—</span>
          )}
        </td>
        <td className="px-3 py-2" title={event.masterAccountId}>
          {event.masterAccountNickname ?? shortId(event.masterAccountId)}
        </td>
        <td className="px-3 py-2">{event.broker}</td>
        <td className="px-3 py-2 font-medium">{event.symbol}</td>
        <td className="px-3 py-2">
          <Badge variant={sideVariant(event.side)}>{event.side}</Badge>
        </td>
        <td className="px-3 py-2 text-right">{event.quantity}</td>
        <td className="px-3 py-2 text-xs">{event.productType || '—'}</td>
        <td className="px-3 py-2 text-right">{event.followersFound}</td>
        <td className="px-3 py-2">
          <Badge variant={outcomeVariant(event.outcome)}>
            {event.outcome.replace(/_/g, ' ')}
          </Badge>
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {followerRollup(event)}
        </td>
      </tr>
      {isOpen && (
        <tr
          className="border-t bg-muted/20"
          data-testid={`trade-monitor-detail-${event.id}`}
        >
          <td colSpan={12} className="px-6 py-4">
            <ExpandedDetail event={event} />
          </td>
        </tr>
      )}
    </>
  );
}

function ExpandedDetail({ event }: { event: ExecutionEvent }) {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Master trade */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" /> Master Trade
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            {event.id}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <DetailRow label="Strategy" value={event.strategyName ?? '—'} />
          <DetailRow label="Strategy id" value={event.strategyId ?? '—'} mono />
          <DetailRow
            label="Master account"
            value={event.masterAccountNickname ?? event.masterAccountId}
          />
          <DetailRow
            label="Account id"
            value={event.masterAccountId}
            mono
          />
          <DetailRow label="Broker" value={event.broker} />
          <DetailRow label="Symbol" value={event.symbol} />
          <DetailRow label="Side" value={event.side} />
          <DetailRow label="Quantity" value={String(event.quantity)} />
          <DetailRow label="Product type" value={event.productType || '—'} />
          <DetailRow label="Time" value={fmtTime(event.timestamp)} />
          <div className="pt-1 flex items-center gap-2">
            <span className="text-xs text-muted-foreground uppercase tracking-wide">
              Outcome
            </span>
            <Badge variant={outcomeVariant(event.outcome)}>
              {event.outcome.replace(/_/g, ' ')}
            </Badge>
          </div>
          {event.errorReason && (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              {event.errorReason}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Follower results */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">
            Follower Results ({event.followers.length})
          </CardTitle>
          <CardDescription>
            {event.followersFound} enabled follower(s) matched this strategy.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {event.followers.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              {event.outcome === 'NO_ACTIVE_STRATEGY'
                ? 'The master trade did not match an active strategy — no followers were attempted.'
                : event.outcome === 'NO_ENABLED_FOLLOWERS'
                ? 'No enabled followers were subscribed to this strategy.'
                : 'No follower attempts were recorded.'}
            </div>
          ) : (
            <div className="divide-y">
              {event.followers.map((f) => (
                <FollowerRow key={f.id} follower={f} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FollowerRow({ follower }: { follower: FollowerExecution }) {
  const Icon = statusIcon(follower.status);
  const iconClass = statusIconClass(follower.status);
  return (
    <div className="p-4 space-y-2">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${iconClass}`} />
          <div>
            <div className="font-medium">
              {follower.followerName}{' '}
              <span className="text-muted-foreground font-normal text-xs">
                ({follower.followerEmail})
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {follower.broker} · account{' '}
              <span className="font-mono">
                {shortId(follower.followerAccountId)}
              </span>
              {follower.followerSymbol && (
                <>
                  {' · '}mapped symbol{' '}
                  <span className="font-mono">{follower.followerSymbol}</span>
                </>
              )}
              {follower.quantity !== null && (
                <> {' · '}qty {follower.quantity}</>
              )}
            </div>
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
      {follower.reason && (
        <div className="rounded-md border bg-muted/40 p-2 text-xs">
          <div className="text-muted-foreground uppercase tracking-wide text-[10px] mb-1">
            Failure reason
          </div>
          <div>{follower.reason}</div>
        </div>
      )}
      {follower.brokerResponse !== null &&
        follower.brokerResponse !== undefined && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Broker response
            </summary>
            <pre className="mt-2 rounded-md border bg-muted/40 p-2 overflow-x-auto text-[11px]">
              {formatResponse(follower.brokerResponse)}
            </pre>
          </details>
        )}
    </div>
  );
}

function statusIcon(status: ExecutionFollowerStatus) {
  switch (status) {
    case 'SUCCESS':
      return CheckCircle2;
    case 'FAILED':
      return XCircle;
    case 'SKIPPED':
      return MinusCircle;
    default:
      return Clock;
  }
}

function statusIconClass(status: ExecutionFollowerStatus) {
  switch (status) {
    case 'SUCCESS':
      return 'text-emerald-500';
    case 'FAILED':
      return 'text-destructive';
    case 'SKIPPED':
      return 'text-muted-foreground';
    default:
      return 'text-amber-500';
  }
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-40 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`flex-1 break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </div>
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
