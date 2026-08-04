'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
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
  ArrowLeft,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  MinusCircle,
} from 'lucide-react';

import {
  api,
  type ExecutionHistoryDetail,
  type ExecutionHistoryFollowerRow,
} from '@/lib/api';

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

// ---------------------------------------------------------------------------

export default function ExecutionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  const [detail, setDetail] = useState<ExecutionHistoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const d = await api.admin.executionHistory.byId(id);
      setDetail(d);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load execution');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) load();
  }, [id, load]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Link
            href="/dashboard/trade-monitor"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
            data-testid="execution-detail-back-btn"
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Trade Monitor
          </Link>
          <h2 className="text-2xl font-bold">Execution Audit</h2>
          <p className="text-muted-foreground font-mono text-xs">{id}</p>
        </div>
        <Button
          variant="outline"
          onClick={load}
          disabled={refreshing || !id}
          data-testid="execution-detail-refresh-btn"
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <div
          className="text-sm text-destructive"
          data-testid="execution-detail-error"
        >
          {error}
        </div>
      ) : !detail ? (
        <div className="text-sm text-muted-foreground">Not found.</div>
      ) : (
        <div className="space-y-6">
          <SummaryStrip detail={detail} />

          <div className="grid gap-6 lg:grid-cols-3">
            <MasterTradeCard detail={detail} />
            <TimelineCard detail={detail} />
            <FailureBreakdownCard detail={detail} />
          </div>

          <FollowerTable followers={detail.followers} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SummaryStrip({ detail }: { detail: ExecutionHistoryDetail }) {
  return (
    <div
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"
      data-testid="execution-detail-summary"
    >
      <StatTile
        label="Status"
        value={detail.status.replace(/_/g, ' ')}
        variant={statusVariant(detail.status)}
      />
      <StatTile label="Followers" value={detail.totalFollowers} />
      <StatTile
        label="Success"
        value={detail.successfulFollowers}
        variant="success"
      />
      <StatTile
        label="Failed"
        value={detail.failedFollowers}
        variant="destructive"
      />
      <StatTile
        label="Skipped"
        value={detail.skippedFollowers}
        variant="muted"
      />
      <StatTile
        label="Processing"
        value={fmtMs(detail.processingTimeMs)}
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

function MasterTradeCard({ detail }: { detail: ExecutionHistoryDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Master Trade</CardTitle>
        <CardDescription>Broker payload received</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Row label="Strategy" value={detail.strategyName ?? '—'} />
        <Row
          label="Strategy id"
          value={detail.strategyId ?? '—'}
          mono
        />
        <Row
          label="Master account"
          value={detail.masterAccountName ?? detail.masterAccountId}
        />
        <Row label="Account id" value={detail.masterAccountId} mono />
        <Row label="Broker" value={detail.masterBroker} />
        <Row label="Symbol" value={detail.masterSymbol} />
        <Row
          label="Exchange / Segment"
          value={`${detail.masterExchange ?? '—'} · ${
            detail.masterSegment ?? '—'
          }`}
        />
        <Row label="Side" value={detail.masterSide} />
        <Row label="Quantity" value={String(detail.masterQuantity)} />
        <Row
          label="Price"
          value={detail.masterPrice === null ? '—' : String(detail.masterPrice)}
        />
        <Row label="Order type" value={detail.orderType ?? '—'} />
        <Row label="Product type" value={detail.productType ?? '—'} />
        <Row label="Trade source" value={detail.tradeSource ?? '—'} />
        <Row label="Received at" value={fmtTime(detail.timestamp)} />
        <Row label="Persisted at" value={fmtTime(detail.createdAt)} />
      </CardContent>
    </Card>
  );
}

function TimelineCard({ detail }: { detail: ExecutionHistoryDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Timeline</CardTitle>
        <CardDescription>
          Chronological reconstruction of the fan-out
        </CardDescription>
      </CardHeader>
      <CardContent>
        {detail.timeline.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No timeline entries recorded.
          </div>
        ) : (
          <ol className="relative border-l pl-4 space-y-3">
            {detail.timeline.map((t, i) => (
              <li key={`${t.at}-${i}`} className="ml-2">
                <div className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border bg-background" />
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t.kind.replace(/_/g, ' ')}
                </div>
                <div className="text-sm">{t.label}</div>
                <div className="text-[11px] text-muted-foreground">
                  {fmtTime(t.at)}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function FailureBreakdownCard({
  detail,
}: {
  detail: ExecutionHistoryDetail;
}) {
  const breakdown = new Map<string, number>();
  for (const f of detail.followers) {
    if (f.failureType) {
      breakdown.set(f.failureType, (breakdown.get(f.failureType) ?? 0) + 1);
    }
  }
  const entries = Array.from(breakdown.entries()).sort((a, b) => b[1] - a[1]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Failure Classification</CardTitle>
        <CardDescription>
          Grouped by failure type across follower attempts
        </CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No failures were recorded for this execution.
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map(([type, count]) => (
              <div
                key={type}
                className="flex items-center justify-between text-sm"
              >
                <div className="font-mono text-xs uppercase">
                  {type.replace(/_/g, ' ')}
                </div>
                <Badge variant="destructive">{count}</Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FollowerTable({
  followers,
}: {
  followers: ExecutionHistoryFollowerRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Follower Execution Table ({followers.length})
        </CardTitle>
        <CardDescription>
          Full audit of every follower attempt with broker payload and response
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {followers.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No follower attempts recorded.
          </div>
        ) : (
          <div className="divide-y">
            {followers.map((f) => (
              <FollowerRow key={f.id} follower={f} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FollowerRow({
  follower,
}: {
  follower: ExecutionHistoryFollowerRow;
}) {
  const Icon =
    follower.status === 'SUCCESS'
      ? CheckCircle2
      : follower.status === 'FAILED'
      ? XCircle
      : follower.status === 'SKIPPED'
      ? MinusCircle
      : Clock;

  const iconClass =
    follower.status === 'SUCCESS'
      ? 'text-emerald-500'
      : follower.status === 'FAILED'
      ? 'text-destructive'
      : follower.status === 'SKIPPED'
      ? 'text-muted-foreground'
      : 'text-amber-500';

  return (
    <div
      className="p-4 space-y-2"
      data-testid={`follower-row-${follower.id}`}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${iconClass}`} />
          <div>
            <div className="font-medium">
              {follower.followerEmail ?? follower.followerId ?? '—'}
            </div>
            <div className="text-xs text-muted-foreground space-x-1">
              <span>{follower.broker}</span>
              {follower.followerSymbol && (
                <>
                  <span>·</span>
                  <span>
                    mapped{' '}
                    <span className="font-mono">
                      {follower.followerSymbol}
                    </span>
                  </span>
                </>
              )}
              {follower.executedQuantity !== null && (
                <>
                  <span>·</span>
                  <span>qty {follower.executedQuantity}</span>
                </>
              )}
              {follower.brokerOrderId && (
                <>
                  <span>·</span>
                  <span>
                    order id{' '}
                    <span className="font-mono">
                      {follower.brokerOrderId}
                    </span>
                  </span>
                </>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {follower.startedAt && (
                <>Started {fmtTime(follower.startedAt)}</>
              )}
              {follower.completedAt && (
                <> · Finished {fmtTime(follower.completedAt)}</>
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
              Raw broker response
            </summary>
            <pre className="mt-2 rounded-md border bg-muted/40 p-2 overflow-x-auto text-[11px]">
              {formatResponse(follower.rawBrokerResponse)}
            </pre>
          </details>
        )}
    </div>
  );
}

function Row({
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
