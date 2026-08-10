'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
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
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  Clock,
  LogOut,
  MinusCircle,
  Pencil,
  RefreshCw,
  XCircle,
} from 'lucide-react';

import {
  api,
  type CancelOrderPayload,
  type ExitOrderPayload,
  type ModifyOrderPayload,
  type OrderActionResult,
  type PositionFollowerLink,
  type PositionLifecycleDetail,
  type PositionLifecycleState,
  type PositionLifecycleTimelineEntry,
} from '@/lib/api';

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

function stateVariant(state: PositionLifecycleState | null | undefined): BadgeVariant {
  switch (state) {
    case 'OPEN':
    case 'PENDING':
      return 'success';
    case 'PARTIALLY_FILLED':
    case 'EXITING':
      return 'warning';
    case 'CANCELLED':
    case 'REJECTED':
      return 'destructive';
    case 'CLOSED':
      return 'muted';
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

function fmtNumber(v: number | null | undefined) {
  return v === null || v === undefined ? '—' : v.toLocaleString();
}

function fmtDecimal(v: number | null | undefined) {
  return v === null || v === undefined ? '—' : String(v);
}

// ---------------------------------------------------------------------------
// Action eligibility (mirrors apps/api/src/order-actions/order-action-rules.ts)
// ---------------------------------------------------------------------------

const ACTIONABLE_BROKERS = new Set(['ZERODHA', 'FYERS', 'ICICI_DIRECT', 'UPSTOX']);

function canModify(p: PositionLifecycleDetail): { ok: boolean; reason: string } {
  if (!ACTIONABLE_BROKERS.has(p.broker)) {
    return { ok: false, reason: `${p.broker} orders cannot be modified from the admin console` };
  }
  if (p.state === 'PENDING' || p.state === 'PARTIALLY_FILLED') {
    return { ok: true, reason: '' };
  }
  return { ok: false, reason: `Cannot modify — position is ${p.state}` };
}

function canCancel(p: PositionLifecycleDetail): { ok: boolean; reason: string } {
  if (!ACTIONABLE_BROKERS.has(p.broker)) {
    return { ok: false, reason: `${p.broker} orders cannot be cancelled from the admin console` };
  }
  if (p.state === 'PENDING' || p.state === 'PARTIALLY_FILLED') {
    return { ok: true, reason: '' };
  }
  if (p.state === 'CANCELLED') {
    return { ok: false, reason: 'Order is already cancelled' };
  }
  return { ok: false, reason: `Cannot cancel — position is ${p.state}` };
}

function canExit(p: PositionLifecycleDetail): { ok: boolean; reason: string } {
  if (!ACTIONABLE_BROKERS.has(p.broker)) {
    return { ok: false, reason: `${p.broker} positions cannot be exited from the admin console` };
  }
  if (p.state === 'OPEN' || p.state === 'PARTIALLY_FILLED') {
    return { ok: true, reason: '' };
  }
  if (p.state === 'CLOSED') {
    return { ok: false, reason: 'Position is already closed' };
  }
  return { ok: false, reason: `Cannot exit — position is ${p.state}` };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OrderDetailPage() {
  const params = useParams<{ key: string }>();
  const key = params?.key ? decodeURIComponent(params.key) : '';

  const [detail, setDetail] = useState<PositionLifecycleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<OrderActionResult | null>(null);

  const [modifyOpen, setModifyOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const d = await api.admin.positionLifecycle.position(key);
      setDetail(d);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load position');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    if (key) load();
  }, [key, load]);

  const modifyEligibility = detail
    ? canModify(detail)
    : { ok: false, reason: '' };
  const cancelEligibility = detail
    ? canCancel(detail)
    : { ok: false, reason: '' };
  const exitEligibility = detail
    ? canExit(detail)
    : { ok: false, reason: '' };

  const onActionComplete = (result: OrderActionResult) => {
    setLastAction(result);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Link
            href="/dashboard/trade-monitor"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
            data-testid="order-detail-back-btn"
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Trade Monitor
          </Link>
          <h2 className="text-2xl font-bold">Order Detail</h2>
          <p className="text-muted-foreground font-mono text-xs" data-testid="order-detail-key">
            {key}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={load}
          disabled={refreshing || !key}
          data-testid="order-detail-refresh-btn"
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
          data-testid="order-detail-error"
        >
          {error}
        </div>
      ) : !detail ? (
        <div className="text-sm text-muted-foreground">Position not tracked.</div>
      ) : (
        <div className="space-y-6">
          <SummaryStrip detail={detail} />

          {lastAction && (
            <ActionResultBanner
              result={lastAction}
              onDismiss={() => setLastAction(null)}
            />
          )}

          <ActionsToolbar
            modify={modifyEligibility}
            cancel={cancelEligibility}
            exit={exitEligibility}
            onModify={() => setModifyOpen(true)}
            onCancel={() => setCancelOpen(true)}
            onExit={() => setExitOpen(true)}
          />

          <div className="grid gap-6 lg:grid-cols-3">
            <MasterOrderCard detail={detail} />
            <TimelineCard timeline={detail.timeline} />
            <BrokerContextCard detail={detail} />
          </div>

          <FollowerSection followers={detail.followers} />
        </div>
      )}

      {detail && (
        <>
          <ModifyOrderDialog
            open={modifyOpen}
            onOpenChange={setModifyOpen}
            detail={detail}
            onComplete={onActionComplete}
          />
          <CancelOrderDialog
            open={cancelOpen}
            onOpenChange={setCancelOpen}
            detail={detail}
            onComplete={onActionComplete}
          />
          <ExitOrderDialog
            open={exitOpen}
            onOpenChange={setExitOpen}
            detail={detail}
            onComplete={onActionComplete}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary strip
// ---------------------------------------------------------------------------

function SummaryStrip({ detail }: { detail: PositionLifecycleDetail }) {
  return (
    <div
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"
      data-testid="order-detail-summary"
    >
      <StatTile
        label="Status"
        value={detail.state.replace(/_/g, ' ')}
        variant={stateVariant(detail.state)}
      />
      <StatTile label="Symbol" value={detail.symbol} />
      <StatTile
        label="Side"
        value={detail.side}
        variant={sideVariant(detail.side)}
      />
      <StatTile
        label="Quantity"
        value={`${detail.filledQuantity}/${detail.quantity}`}
        variant="secondary"
      />
      <StatTile
        label="Pending"
        value={fmtNumber(detail.pendingQuantity)}
        variant="outline"
      />
      <StatTile
        label="Followers"
        value={detail.followerCount}
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
          <div className="text-2xl font-semibold break-all">{value}</div>
          <Badge variant={variant} className="uppercase tracking-wide">
            {label}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Actions toolbar
// ---------------------------------------------------------------------------

function ActionsToolbar({
  modify,
  cancel,
  exit,
  onModify,
  onCancel,
  onExit,
}: {
  modify: { ok: boolean; reason: string };
  cancel: { ok: boolean; reason: string };
  exit: { ok: boolean; reason: string };
  onModify: () => void;
  onCancel: () => void;
  onExit: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Order Actions</CardTitle>
        <CardDescription>
          Every action is applied to the master order and propagates through
          the existing execution pipeline to the linked follower orders.
          Followers are never actioned directly.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-3">
        <ActionButton
          label="Modify"
          icon={<Pencil className="h-4 w-4 mr-2" />}
          eligibility={modify}
          onClick={onModify}
          variant="default"
          testId="order-action-modify-btn"
        />
        <ActionButton
          label="Cancel"
          icon={<Ban className="h-4 w-4 mr-2" />}
          eligibility={cancel}
          onClick={onCancel}
          variant="outline"
          testId="order-action-cancel-btn"
        />
        <ActionButton
          label="Exit Position"
          icon={<LogOut className="h-4 w-4 mr-2" />}
          eligibility={exit}
          onClick={onExit}
          variant="destructive"
          testId="order-action-exit-btn"
        />
      </CardContent>
    </Card>
  );
}

function ActionButton({
  label,
  icon,
  eligibility,
  onClick,
  variant,
  testId,
}: {
  label: string;
  icon: React.ReactNode;
  eligibility: { ok: boolean; reason: string };
  onClick: () => void;
  variant: 'default' | 'outline' | 'destructive';
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant={variant}
        onClick={onClick}
        disabled={!eligibility.ok}
        data-testid={testId}
      >
        {icon}
        {label}
      </Button>
      {!eligibility.ok && eligibility.reason && (
        <span className="text-[11px] text-muted-foreground max-w-[220px]">
          {eligibility.reason}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action result banner
// ---------------------------------------------------------------------------

function ActionResultBanner({
  result,
  onDismiss,
}: {
  result: OrderActionResult;
  onDismiss: () => void;
}) {
  const ok = result.accepted;
  return (
    <Card
      className={ok ? 'border-emerald-400/60' : 'border-destructive/60'}
      data-testid="order-action-result-banner"
    >
      <CardContent className="p-4 flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant={ok ? 'success' : 'destructive'}>
              {result.action} {ok ? 'ACCEPTED' : 'REJECTED'}
            </Badge>
            {result.nextState && (
              <Badge variant={stateVariant(result.nextState)}>
                {result.nextState.replace(/_/g, ' ')}
              </Badge>
            )}
          </div>
          {result.reason && (
            <div className="text-sm text-muted-foreground">
              {result.reason}
            </div>
          )}
          {result.followerSync.length > 0 && (
            <div className="text-xs text-muted-foreground">
              {result.followerSync.filter((f) => f.ok).length} of{' '}
              {result.followerSync.length} follower{' '}
              {result.action.toLowerCase()} succeeded
            </div>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Master order info
// ---------------------------------------------------------------------------

function MasterOrderCard({ detail }: { detail: PositionLifecycleDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Master Order</CardTitle>
        <CardDescription>Single source of truth</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Row label="Status" value={detail.state.replace(/_/g, ' ')} />
        <Row label="Broker" value={detail.broker} />
        <Row label="Exchange" value={detail.exchange ?? '—'} />
        <Row label="Symbol" value={detail.symbol} />
        <Row label="Side" value={detail.side} />
        <Row label="Product" value={detail.productType ?? '—'} />
        <Row label="Order type" value={detail.orderType ?? '—'} />
        <Row
          label="Quantity"
          value={`${detail.filledQuantity}/${detail.quantity} filled · ${detail.pendingQuantity} pending`}
        />
        <Row label="Price" value={fmtDecimal(detail.price)} />
        <Row label="Trigger price" value={fmtDecimal(detail.triggerPrice)} />
        <Row label="Created" value={fmtTime(detail.createdAt)} />
        <Row label="Last updated" value={fmtTime(detail.updatedAt)} />
        {detail.closedAt && (
          <Row label="Closed" value={fmtTime(detail.closedAt)} />
        )}
        <Row label="Broker order id" value={detail.brokerOrderId} mono />
        <Row label="Position key" value={detail.key} mono />
        {detail.strategyId && (
          <Row label="Strategy id" value={detail.strategyId} mono />
        )}
      </CardContent>
    </Card>
  );
}

function BrokerContextCard({ detail }: { detail: PositionLifecycleDetail }) {
  // Sprint 5.5.1 — surface the operational metadata operators asked
  // for. Market Protection and Execution Source are not tracked on
  // the lifecycle record itself; we derive them where possible from
  // the latest lifecycle timeline entry which carries the trade
  // source label committed by the recorder.
  const latestSource = useMemo(() => {
    for (let i = detail.timeline.length - 1; i >= 0; i--) {
      const entry = detail.timeline[i];
      const details = entry?.details as Record<string, unknown> | undefined;
      const source = details?.tradeSource ?? details?.source;
      if (typeof source === 'string' && source.length > 0) return source;
    }
    return null;
  }, [detail.timeline]);

  const latestReason = useMemo(() => {
    for (let i = detail.timeline.length - 1; i >= 0; i--) {
      const entry = detail.timeline[i];
      const details = entry?.details as Record<string, unknown> | undefined;
      if (typeof details?.reason === 'string' && details.reason.length > 0) {
        return details.reason as string;
      }
    }
    return null;
  }, [detail.timeline]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Broker &amp; Execution Context</CardTitle>
        <CardDescription>Complementary metadata</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Row
          label="Execution source"
          value={latestSource ?? '—'}
          testid="order-detail-execution-source"
        />
        <Row
          label="Market protection"
          value={
            detail.orderType === 'MARKET' ? 'Broker default' : 'Not applicable'
          }
        />
        <Row label="Master account id" value={detail.masterAccountId} mono />
        <Row
          label="Execution id"
          value={detail.brokerOrderId}
          mono
          testid="order-detail-execution-id"
        />
        <Row label="Follower count" value={String(detail.followerCount)} />
        <Row
          label="Latest reason"
          value={latestReason ?? '—'}
        />
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  mono,
  testid,
}: {
  label: string;
  value: string;
  mono?: boolean;
  testid?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-40 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`flex-1 break-all ${mono ? 'font-mono text-xs' : ''}`}
        data-testid={testid}
      >
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function TimelineCard({
  timeline,
}: {
  timeline: PositionLifecycleTimelineEntry[];
}) {
  const sorted = [...timeline].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Timeline</CardTitle>
        <CardDescription>
          Requested → Broker Submitted → Broker Response → Follower Execution →
          Completed / Failed
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No lifecycle events recorded yet.
          </div>
        ) : (
          <ol
            className="relative border-l pl-4 space-y-3"
            data-testid="order-detail-timeline"
          >
            {sorted.map((t, i) => (
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

// ---------------------------------------------------------------------------
// Follower section — read-only. NO action buttons per sprint contract.
// ---------------------------------------------------------------------------

function FollowerSection({
  followers,
}: {
  followers: PositionFollowerLink[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Follower Executions ({followers.length})
        </CardTitle>
        <CardDescription>
          Followers mirror the master order — actions must originate from the
          master and are dispatched through the shared execution pipeline.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {followers.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No follower orders are linked to this position yet.
          </div>
        ) : (
          <div className="divide-y">
            {followers.map((f) => (
              <FollowerRow key={`${f.followerAccountId}-${f.brokerOrderId}`} f={f} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FollowerRow({ f }: { f: PositionFollowerLink }) {
  const ok = f.lastActionOk;
  const Icon = ok
    ? CheckCircle2
    : f.lastActionMessage
    ? XCircle
    : f.lastAction === 'PLACE'
    ? Clock
    : MinusCircle;
  const iconClass = ok
    ? 'text-emerald-500'
    : f.lastActionMessage
    ? 'text-destructive'
    : 'text-muted-foreground';

  return (
    <div
      className="p-4 space-y-1"
      data-testid={`order-detail-follower-${f.followerAccountId}`}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${iconClass}`} />
          <div>
            <div className="font-medium">
              {f.followerEmail ?? f.followerAccountId}
            </div>
            <div className="text-xs text-muted-foreground">
              {f.broker}
              {f.followerSymbol && (
                <>
                  {' · '}mapped{' '}
                  <span className="font-mono">{f.followerSymbol}</span>
                </>
              )}
              {f.quantity !== null && <> {' · '}qty {f.quantity}</>}
            </div>
            <div className="text-xs text-muted-foreground">
              order id <span className="font-mono">{f.brokerOrderId}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Last action {fmtTime(f.lastActionAt)}
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant={ok ? 'success' : 'destructive'}>{f.lastAction}</Badge>
          {!ok && f.lastActionMessage && (
            <span className="text-xs text-muted-foreground max-w-[240px] text-right">
              {f.lastActionMessage}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modify dialog
// ---------------------------------------------------------------------------

function ModifyOrderDialog({
  open,
  onOpenChange,
  detail,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  detail: PositionLifecycleDetail;
  onComplete: (result: OrderActionResult) => void;
}) {
  const [quantity, setQuantity] = useState<string>('');
  const [price, setPrice] = useState<string>('');
  const [triggerPrice, setTriggerPrice] = useState<string>('');
  const [orderType, setOrderType] = useState<string>(
    detail.orderType ?? '',
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setQuantity(String(detail.quantity));
      setPrice(detail.price === null ? '' : String(detail.price));
      setTriggerPrice(
        detail.triggerPrice === null ? '' : String(detail.triggerPrice),
      );
      setOrderType(detail.orderType ?? '');
      setError(null);
    }
  }, [open, detail]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payload: ModifyOrderPayload = {};
      if (quantity !== '' && Number(quantity) !== detail.quantity) {
        payload.quantity = Number(quantity);
      }
      if (
        price !== '' &&
        Number(price) !== detail.price
      ) {
        payload.price = Number(price);
      }
      if (
        triggerPrice !== '' &&
        Number(triggerPrice) !== detail.triggerPrice
      ) {
        payload.triggerPrice = Number(triggerPrice);
      }
      if (orderType && orderType !== detail.orderType) {
        payload.orderType = orderType as ModifyOrderPayload['orderType'];
      }
      if (Object.keys(payload).length === 0) {
        setError('No changes to apply');
        setSubmitting(false);
        return;
      }
      const result = await api.admin.orderActions.modify(detail.key, payload);
      onComplete(result);
      onOpenChange(false);
    } catch (e: any) {
      setError(e?.message ?? 'Modify request failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="order-modify-dialog">
        <DialogHeader>
          <DialogTitle>Modify Order</DialogTitle>
          <DialogDescription>
            Applies to the master order. Followers are modified through the
            shared execution pipeline automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity">
              <Input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                data-testid="order-modify-quantity"
              />
            </Field>
            <Field label="Order type">
              <Select
                value={orderType}
                onChange={(e) => setOrderType(e.target.value)}
                data-testid="order-modify-order-type"
              >
                <option value="">Unchanged</option>
                <option value="MARKET">MARKET</option>
                <option value="LIMIT">LIMIT</option>
                <option value="SL">SL</option>
                <option value="SL-M">SL-M</option>
              </Select>
            </Field>
            <Field label="Price">
              <Input
                type="number"
                step="0.05"
                min={0}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                data-testid="order-modify-price"
              />
            </Field>
            <Field label="Trigger price">
              <Input
                type="number"
                step="0.05"
                min={0}
                value={triggerPrice}
                onChange={(e) => setTriggerPrice(e.target.value)}
                data-testid="order-modify-trigger-price"
              />
            </Field>
          </div>
          {error && (
            <div
              className="text-sm text-destructive"
              data-testid="order-modify-error"
            >
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="order-modify-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={submitting}
            data-testid="order-modify-submit"
          >
            {submitting ? 'Submitting…' : 'Modify Order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
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
// Cancel dialog
// ---------------------------------------------------------------------------

function CancelOrderDialog({
  open,
  onOpenChange,
  detail,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  detail: PositionLifecycleDetail;
  onComplete: (result: OrderActionResult) => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payload: CancelOrderPayload = reason ? { reason } : {};
      const result = await api.admin.orderActions.cancel(detail.key, payload);
      onComplete(result);
      onOpenChange(false);
    } catch (e: any) {
      setError(e?.message ?? 'Cancel request failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="order-cancel-dialog">
        <DialogHeader>
          <DialogTitle>Cancel Order</DialogTitle>
          <DialogDescription>
            Cancels the master order. Eligible follower orders are cancelled
            automatically through the shared execution pipeline.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Reason (optional)">
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              data-testid="order-cancel-reason"
            />
          </Field>
          {error && (
            <div
              className="text-sm text-destructive"
              data-testid="order-cancel-error"
            >
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="order-cancel-back"
          >
            Keep Order
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={submitting}
            data-testid="order-cancel-submit"
          >
            {submitting ? 'Submitting…' : 'Cancel Order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Exit dialog
// ---------------------------------------------------------------------------

function ExitOrderDialog({
  open,
  onOpenChange,
  detail,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  detail: PositionLifecycleDetail;
  onComplete: (result: OrderActionResult) => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payload: ExitOrderPayload = reason ? { reason } : {};
      const result = await api.admin.orderActions.exit(detail.key, payload);
      onComplete(result);
      onOpenChange(false);
    } catch (e: any) {
      setError(e?.message ?? 'Exit request failed');
    } finally {
      setSubmitting(false);
    }
  };

  const exitQuantity =
    detail.filledQuantity > 0 ? detail.filledQuantity : detail.quantity;
  const reverseSide = detail.side === 'BUY' ? 'SELL' : 'BUY';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="order-exit-dialog">
        <DialogHeader>
          <DialogTitle>Exit Position</DialogTitle>
          <DialogDescription>
            Places a reverse MARKET order on the master account for the
            currently open filled quantity. Followers exit through the shared
            execution pipeline.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="rounded-md border bg-muted/40 p-3 space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Symbol</span>
              <span className="font-medium">{detail.symbol}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Reverse side</span>
              <span className="font-medium">{reverseSide}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Exit quantity</span>
              <span className="font-medium">{exitQuantity}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Order type</span>
              <span className="font-medium">MARKET</span>
            </div>
          </div>
          <Field label="Reason (optional)">
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              data-testid="order-exit-reason"
            />
          </Field>
          {error && (
            <div
              className="text-sm text-destructive"
              data-testid="order-exit-error"
            >
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="order-exit-back"
          >
            Hold Position
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={submitting}
            data-testid="order-exit-submit"
          >
            {submitting ? 'Submitting…' : 'Exit Position'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
