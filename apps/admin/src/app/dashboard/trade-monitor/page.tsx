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
} from 'lucide-react';

import {
  api,
  type TradeEventPipelineSummary,
  type TradeEventRecord,
  type TradeEventStatus,
} from '@/lib/api';

// ---------------------------------------------------------------------------
// Status badge — colour-codes the pipeline lifecycle. Read-only rendering.
// ---------------------------------------------------------------------------

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'muted';

function statusVariant(status: TradeEventStatus): BadgeVariant {
  switch (status) {
    case 'READY':
      return 'success';
    case 'VALIDATED':
      return 'warning';
    case 'NORMALIZED':
    case 'RECEIVED':
      return 'secondary';
    case 'DUPLICATE':
      return 'muted';
    case 'REJECTED':
      return 'destructive';
    default:
      return 'outline';
  }
}

function sideVariant(side: 'BUY' | 'SELL'): BadgeVariant {
  return side === 'BUY' ? 'success' : 'destructive';
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTime(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtNum(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  return typeof n === 'number' ? n.toLocaleString() : String(n);
}

function shortId(id: string | null | undefined, n = 8) {
  if (!id) return '—';
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TradeMonitorPage() {
  const [summary, setSummary] = useState<TradeEventPipelineSummary | null>(null);
  const [items, setItems] = useState<TradeEventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TradeEventRecord | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const [s, r] = await Promise.all([
        api.admin.tradeEvents.summary(),
        api.admin.tradeEvents.recent(50),
      ]);
      setSummary(s);
      setItems(r.items);
      // Keep the currently-selected record in sync if it's still in the buffer.
      if (selected) {
        const stillThere = r.items.find(
          (x) => x.event.id === selected.event.id,
        );
        setSelected(stillThere ?? null);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load trade events');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    load();
    // No polling / websocket — refresh is manual per foundation scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6" /> Trade Monitor
          </h2>
          <p className="text-muted-foreground">
            Read-only view of the Trade Event Intake pipeline.
            Normalization → Validation → Execution Readiness.
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

      {/* Pipeline summary */}
      <div
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"
        data-testid="trade-monitor-summary"
      >
        <SummaryCard
          label="Buffer"
          value={
            summary
              ? `${summary.bufferSize}/${summary.bufferCapacity}`
              : '—'
          }
        />
        <SummaryCard
          label="Ready"
          value={summary?.counts.READY ?? 0}
          variant="success"
        />
        <SummaryCard
          label="Validated"
          value={summary?.counts.VALIDATED ?? 0}
          variant="warning"
        />
        <SummaryCard
          label="Duplicate"
          value={summary?.counts.DUPLICATE ?? 0}
          variant="muted"
        />
        <SummaryCard
          label="Rejected"
          value={summary?.counts.REJECTED ?? 0}
          variant="destructive"
        />
        <SummaryCard
          label="Normalized"
          value={summary?.counts.NORMALIZED ?? 0}
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

      {/* Events table */}
      <Card>
        <CardHeader>
          <CardTitle>Latest Trade Events</CardTitle>
          <CardDescription>
            Most recent first. In-memory rolling buffer — foundation scope has
            no persistence yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : items.length === 0 ? (
            <div
              className="p-6 text-sm text-muted-foreground"
              data-testid="trade-monitor-empty"
            >
              No trade events have entered the pipeline yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-2">Time</th>
                    <th className="text-left px-4 py-2">Source</th>
                    <th className="text-left px-4 py-2">Broker</th>
                    <th className="text-left px-4 py-2">Master</th>
                    <th className="text-left px-4 py-2">Strategy</th>
                    <th className="text-left px-4 py-2">Symbol</th>
                    <th className="text-left px-4 py-2">Side</th>
                    <th className="text-right px-4 py-2">Qty</th>
                    <th className="text-right px-4 py-2">Price</th>
                    <th className="text-left px-4 py-2">Status</th>
                    <th className="text-left px-4 py-2">Validation</th>
                  </tr>
                </thead>
                <tbody data-testid="trade-monitor-table-body">
                  {items.map((rec) => {
                    const active = selected?.event.id === rec.event.id;
                    const v = rec.validation;
                    const validationSummary = v
                      ? v.ok
                        ? `${v.checks.length}/${v.checks.length} passed`
                        : `${v.errors.length} of ${v.checks.length} failed`
                      : '—';
                    const validationVariant: BadgeVariant = v
                      ? v.ok
                        ? 'success'
                        : 'destructive'
                      : 'muted';
                    return (
                      <tr
                        key={rec.event.id}
                        onClick={() => setSelected(rec)}
                        className={`border-t cursor-pointer transition-colors ${
                          active ? 'bg-accent' : 'hover:bg-accent/40'
                        }`}
                        data-testid={`trade-monitor-row-${rec.event.id}`}
                      >
                        <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                          {fmtTime(rec.event.receivedAt)}
                        </td>
                        <td className="px-4 py-2">{rec.event.source}</td>
                        <td className="px-4 py-2">{rec.event.broker}</td>
                        <td
                          className="px-4 py-2 font-mono text-xs"
                          title={rec.event.masterAccountId}
                        >
                          {shortId(rec.event.masterAccountId)}
                        </td>
                        <td
                          className="px-4 py-2 font-mono text-xs"
                          title={rec.event.strategyId ?? ''}
                        >
                          {shortId(rec.event.strategyId)}
                        </td>
                        <td className="px-4 py-2 font-medium">
                          {rec.event.brokerSymbol || '—'}
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={sideVariant(rec.event.side)}>
                            {rec.event.side}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-right">
                          {fmtNum(rec.event.quantity)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {fmtNum(rec.event.price)}
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={statusVariant(rec.event.status)}>
                            {rec.event.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={validationVariant}>
                            {validationSummary}
                          </Badge>
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

      {/* Detail panel */}
      {selected && <RecordDetail record={selected} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary tile
// ---------------------------------------------------------------------------

function SummaryCard({
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
// Detail panel — validation + readiness breakdown for the selected record.
// ---------------------------------------------------------------------------

function RecordDetail({ record }: { record: TradeEventRecord }) {
  const { event, validation, readiness, rejectionReason } = record;
  return (
    <div className="grid gap-6 lg:grid-cols-2" data-testid="trade-monitor-detail">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Event</CardTitle>
          <CardDescription className="font-mono text-xs">
            {event.id}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <DetailRow label="Source" value={event.source} />
          <DetailRow label="Broker" value={event.broker} />
          <DetailRow label="Master account" value={event.masterAccountId} mono />
          <DetailRow label="Strategy" value={event.strategyId ?? '—'} mono />
          <DetailRow label="Broker order id" value={event.brokerOrderId} mono />
          <DetailRow
            label="Broker execution id"
            value={event.brokerExecutionId ?? '—'}
            mono
          />
          <DetailRow label="Symbol" value={event.brokerSymbol} />
          <DetailRow label="Contract key" value={event.contractKey ?? '—'} mono />
          <DetailRow label="Side" value={event.side} />
          <DetailRow label="Quantity" value={String(event.quantity)} />
          <DetailRow
            label="Price"
            value={event.price === null ? '—' : String(event.price)}
          />
          <DetailRow label="Broker status" value={event.rawStatus ?? '—'} />
          <DetailRow label="Broker time" value={fmtTime(event.brokerTimestamp)} />
          <DetailRow label="Received" value={fmtTime(event.receivedAt)} />
          <div className="pt-1 flex items-center gap-2">
            <span className="text-xs text-muted-foreground uppercase tracking-wide">
              Status
            </span>
            <Badge variant={statusVariant(event.status)}>{event.status}</Badge>
          </div>
          {rejectionReason && (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              {rejectionReason}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Validation</CardTitle>
            <CardDescription>
              {validation
                ? validation.ok
                  ? 'All pre-execution checks passed'
                  : `${validation.errors.length} check(s) failed`
                : 'No validation was run'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {validation ? (
              validation.checks.map((c) => (
                <CheckRow
                  key={c.key}
                  ok={c.ok}
                  label={c.key}
                  message={c.message}
                />
              ))
            ) : (
              <div className="text-sm text-muted-foreground">
                Validation was not run for this event.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Execution Readiness</CardTitle>
            <CardDescription>
              {readiness
                ? readiness.ready
                  ? 'Available for downstream CopyTradingService'
                  : readiness.reason ??
                    'Not yet ready for downstream execution'
                : 'Readiness gate was not run (event did not pass validation)'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {readiness ? (
              readiness.checks.map((c) => (
                <CheckRow
                  key={c.key}
                  ok={c.ok}
                  label={c.key}
                  message={c.message}
                />
              ))
            ) : (
              <div className="text-sm text-muted-foreground">
                Readiness gate was skipped.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
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

function CheckRow({
  ok,
  label,
  message,
}: {
  ok: boolean;
  label: string;
  message: string;
}) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <div className="flex items-start gap-3 text-sm">
      <Icon
        className={`h-4 w-4 mt-0.5 shrink-0 ${
          ok ? 'text-emerald-500' : 'text-destructive'
        }`}
      />
      <div className="flex-1">
        <div className="font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{message}</div>
      </div>
    </div>
  );
}
