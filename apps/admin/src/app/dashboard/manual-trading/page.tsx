'use client';

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
  Zap,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  MinusCircle,
  AlertTriangle,
} from 'lucide-react';

import {
  api,
  type ManualTradeOrderType,
  type ManualTradeProduct,
  type ManualTradeRecord,
  type ManualTradeSide,
  type ManualTradeStatus,
  type ManualTradeValidationCheck,
  type ManualTradeValidity,
  type PlaceManualTradePayload,
} from '@/lib/api';
import type { StrategyDto, TradingAccountDto } from '@cts/shared';

// ---------------------------------------------------------------------------

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'muted';

const ORDER_TYPES: { value: ManualTradeOrderType; label: string }[] = [
  { value: 'MARKET', label: 'MARKET' },
  { value: 'LIMIT', label: 'LIMIT' },
  { value: 'SL', label: 'SL' },
  { value: 'SL-M', label: 'SL-M' },
];

const PRODUCTS: { value: ManualTradeProduct; label: string }[] = [
  { value: 'MIS', label: 'MIS (Intraday)' },
  { value: 'CNC', label: 'CNC (Delivery)' },
  { value: 'NRML', label: 'NRML (Normal)' },
];

const VALIDITIES: { value: ManualTradeValidity; label: string }[] = [
  { value: 'DAY', label: 'DAY' },
  { value: 'IOC', label: 'IOC' },
];

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'];

interface FormState {
  masterAccountId: string;
  strategyId: string;
  exchange: string;
  symbol: string;
  side: ManualTradeSide;
  orderType: ManualTradeOrderType;
  quantity: string;
  product: ManualTradeProduct;
  price: string;
  triggerPrice: string;
  validity: ManualTradeValidity;
}

const INITIAL_FORM: FormState = {
  masterAccountId: '',
  strategyId: '',
  exchange: 'NSE',
  symbol: '',
  side: 'BUY',
  orderType: 'MARKET',
  quantity: '',
  product: 'MIS',
  price: '',
  triggerPrice: '',
  validity: 'DAY',
};

function statusVariant(status: ManualTradeStatus): BadgeVariant {
  switch (status) {
    case 'COMPLETED':
      return 'success';
    case 'ACCEPTED':
    case 'EXECUTING_FOLLOWERS':
    case 'PENDING':
      return 'warning';
    case 'PARTIAL':
      return 'warning';
    case 'REJECTED':
    case 'FAILED':
      return 'destructive';
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

function statusText(status: ManualTradeStatus) {
  return status.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type AdminTradingAccount = TradingAccountDto & {
  user?: { email: string; name: string | null };
};
type AdminStrategy = StrategyDto & {
  tradingAccount?: { nickname: string; broker: any; user?: { email: string } };
};

export default function ManualTradingPage() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [masters, setMasters] = useState<AdminTradingAccount[]>([]);
  const [strategies, setStrategies] = useState<AdminStrategy[]>([]);
  const [recent, setRecent] = useState<ManualTradeRecord[]>([]);
  const [lastResult, setLastResult] = useState<ManualTradeRecord | null>(null);
  const [validationErrors, setValidationErrors] = useState<
    ManualTradeValidationCheck[] | null
  >(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placementError, setPlacementError] = useState<string | null>(null);

  const loadMeta = useCallback(async () => {
    setError(null);
    try {
      const [m, s] = await Promise.all([
        api.admin.masterAccounts.list(),
        api.admin.listStrategies(),
      ]);
      setMasters(m);
      setStrategies(s);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load master accounts / strategies');
    }
  }, []);

  const loadRecent = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api.admin.manualTrading.recent(50);
      setRecent(r.items);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load recent manual trades');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadMeta();
    loadRecent();
  }, [loadMeta, loadRecent]);

  // Refresh the recent list every 4s so PARTIAL / COMPLETED transitions
  // land in the UI shortly after CopyTradingService commits the fan-out.
  useEffect(() => {
    const t = setInterval(() => {
      loadRecent();
    }, 4000);
    return () => clearInterval(t);
  }, [loadRecent]);

  const eligibleStrategies = useMemo(() => {
    if (!form.masterAccountId) return [] as AdminStrategy[];
    return strategies.filter(
      (s) => s.tradingAccountId === form.masterAccountId,
    );
  }, [form.masterAccountId, strategies]);

  const activeStrategy = eligibleStrategies.find((s) => s.id === form.strategyId);
  const activeMaster = masters.find((m) => m.id === form.masterAccountId);

  const needsPrice = form.orderType === 'LIMIT' || form.orderType === 'SL';
  const needsTrigger = form.orderType === 'SL' || form.orderType === 'SL-M';

  const canSubmit =
    !submitting &&
    !!form.masterAccountId &&
    !!form.strategyId &&
    !!form.exchange &&
    !!form.symbol &&
    !!form.quantity &&
    Number(form.quantity) > 0 &&
    (!needsPrice || (!!form.price && Number(form.price) > 0)) &&
    (!needsTrigger || (!!form.triggerPrice && Number(form.triggerPrice) > 0));

  const submit = async () => {
    setSubmitting(true);
    setValidationErrors(null);
    setPlacementError(null);
    setLastResult(null);
    try {
      const payload: PlaceManualTradePayload = {
        masterAccountId: form.masterAccountId,
        strategyId: form.strategyId,
        exchange: form.exchange.trim(),
        symbol: form.symbol.trim().toUpperCase(),
        side: form.side,
        orderType: form.orderType,
        quantity: Number(form.quantity),
        product: form.product,
        validity: form.validity,
      };
      if (needsPrice) payload.price = Number(form.price);
      if (needsTrigger) payload.triggerPrice = Number(form.triggerPrice);

      const res = await api.admin.manualTrading.place(payload);
      setLastResult(res);
      await loadRecent();
    } catch (e: any) {
      const body = e?.body;
      if (Array.isArray(body?.errors)) {
        setValidationErrors(body.errors as ManualTradeValidationCheck[]);
        setPlacementError(body?.message ?? 'Manual trade rejected');
      } else {
        setPlacementError(e?.message ?? 'Failed to place manual trade');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setForm(INITIAL_FORM);
    setValidationErrors(null);
    setPlacementError(null);
    setLastResult(null);
  };

  return (
    <div className="space-y-6" data-testid="manual-trading-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Zap className="h-6 w-6" /> Manual Trading
          </h2>
          <p className="text-muted-foreground">
            Place a master trade directly from CTS. Orders travel through the
            same execution pipeline as broker-detected trades and appear in
            Trade Monitor / Execution History tagged as{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">MANUAL</code>.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={loadRecent}
          disabled={refreshing}
          data-testid="manual-trading-refresh-btn"
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      {error && (
        <div
          className="text-sm text-destructive"
          data-testid="manual-trading-error"
        >
          {error}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2 space-y-6">
          <OrderEntryPanel
            form={form}
            setForm={setForm}
            masters={masters}
            eligibleStrategies={eligibleStrategies}
            needsPrice={needsPrice}
            needsTrigger={needsTrigger}
            submitting={submitting}
            canSubmit={canSubmit}
            onSubmit={submit}
            onReset={reset}
            activeMaster={activeMaster}
            activeStrategy={activeStrategy}
          />

          <RecentOrdersTable rows={recent} />
        </div>

        <div className="space-y-6">
          <ExecutionStatusPanel result={lastResult} error={placementError} />
          <ValidationSummary
            errors={validationErrors}
            record={lastResult}
          />
          <LiveOrderResponsePanel record={lastResult} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Order Entry Panel
// ---------------------------------------------------------------------------

function OrderEntryPanel({
  form,
  setForm,
  masters,
  eligibleStrategies,
  needsPrice,
  needsTrigger,
  submitting,
  canSubmit,
  onSubmit,
  onReset,
  activeMaster,
  activeStrategy,
}: {
  form: FormState;
  setForm: (patch: FormState) => void;
  masters: AdminTradingAccount[];
  eligibleStrategies: AdminStrategy[];
  needsPrice: boolean;
  needsTrigger: boolean;
  submitting: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  onReset: () => void;
  activeMaster?: AdminTradingAccount;
  activeStrategy?: AdminStrategy;
}) {
  const patch = (delta: Partial<FormState>) => setForm({ ...form, ...delta });

  return (
    <Card data-testid="order-entry-panel">
      <CardHeader>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle>Order Entry</CardTitle>
            <CardDescription>
              Trade routes to the master broker via the existing BrokerAdapter,
              then fans out to enabled followers through CopyTradingService.
            </CardDescription>
          </div>
          {activeMaster && (
            <Badge
              variant={
                activeMaster.connectionStatus === 'CONNECTED'
                  ? 'success'
                  : 'destructive'
              }
            >
              {activeMaster.broker} · {activeMaster.connectionStatus}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Master Account">
            <Select
              value={form.masterAccountId}
              onChange={(e) =>
                patch({ masterAccountId: e.target.value, strategyId: '' })
              }
              data-testid="field-master-account"
            >
              <option value="">— Select master account —</option>
              {masters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nickname} · {m.broker} · {m.connectionStatus}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Strategy">
            <Select
              value={form.strategyId}
              onChange={(e) => patch({ strategyId: e.target.value })}
              disabled={!form.masterAccountId}
              data-testid="field-strategy"
            >
              <option value="">— Select strategy —</option>
              {eligibleStrategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.strategyName} · {s.status} · {s.enabled ? 'enabled' : 'disabled'}
                </option>
              ))}
            </Select>
            {activeStrategy && activeStrategy.status !== 'ACTIVE' && (
              <div className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Strategy is not ACTIVE
              </div>
            )}
          </Field>

          <Field label="Exchange">
            <Select
              value={form.exchange}
              onChange={(e) => patch({ exchange: e.target.value })}
              data-testid="field-exchange"
            >
              {EXCHANGES.map((ex) => (
                <option key={ex} value={ex}>
                  {ex}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Symbol">
            <Input
              placeholder="e.g. NIFTY24DEC24000CE"
              value={form.symbol}
              onChange={(e) =>
                patch({ symbol: e.target.value.toUpperCase() })
              }
              spellCheck={false}
              data-testid="field-symbol"
            />
          </Field>

          <Field label="Transaction">
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={form.side === 'BUY' ? 'default' : 'outline'}
                className={
                  form.side === 'BUY'
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    : ''
                }
                onClick={() => patch({ side: 'BUY' })}
                data-testid="field-side-buy"
              >
                BUY
              </Button>
              <Button
                type="button"
                variant={form.side === 'SELL' ? 'default' : 'outline'}
                className={
                  form.side === 'SELL'
                    ? 'bg-rose-600 hover:bg-rose-700 text-white'
                    : ''
                }
                onClick={() => patch({ side: 'SELL' })}
                data-testid="field-side-sell"
              >
                SELL
              </Button>
            </div>
          </Field>

          <Field label="Order Type">
            <Select
              value={form.orderType}
              onChange={(e) =>
                patch({ orderType: e.target.value as ManualTradeOrderType })
              }
              data-testid="field-order-type"
            >
              {ORDER_TYPES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Quantity">
            <Input
              type="number"
              min={1}
              step={1}
              placeholder="e.g. 75"
              value={form.quantity}
              onChange={(e) => patch({ quantity: e.target.value })}
              data-testid="field-quantity"
            />
          </Field>

          <Field label="Product">
            <Select
              value={form.product}
              onChange={(e) =>
                patch({ product: e.target.value as ManualTradeProduct })
              }
              data-testid="field-product"
            >
              {PRODUCTS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={needsPrice ? 'Price (required)' : 'Price'}>
            <Input
              type="number"
              min={0}
              step="0.05"
              placeholder="Limit / SL price"
              value={form.price}
              onChange={(e) => patch({ price: e.target.value })}
              disabled={!needsPrice && form.orderType !== 'SL-M' ? false : false}
              data-testid="field-price"
            />
          </Field>

          <Field
            label={needsTrigger ? 'Trigger Price (required)' : 'Trigger Price'}
          >
            <Input
              type="number"
              min={0}
              step="0.05"
              placeholder="Stop-loss trigger"
              value={form.triggerPrice}
              onChange={(e) => patch({ triggerPrice: e.target.value })}
              data-testid="field-trigger-price"
            />
          </Field>

          <Field label="Validity">
            <Select
              value={form.validity}
              onChange={(e) =>
                patch({ validity: e.target.value as ManualTradeValidity })
              }
              data-testid="field-validity"
            >
              {VALIDITIES.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex items-center gap-3 pt-2 border-t">
          <Button
            disabled={!canSubmit}
            onClick={onSubmit}
            className={
              form.side === 'BUY'
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                : 'bg-rose-600 hover:bg-rose-700 text-white'
            }
            data-testid="place-order-btn"
          >
            {submitting
              ? 'Placing…'
              : form.side === 'BUY'
              ? 'Place Buy Order'
              : 'Place Sell Order'}
          </Button>
          <Button
            variant="outline"
            onClick={onReset}
            disabled={submitting}
            data-testid="reset-btn"
          >
            Reset
          </Button>
        </div>
      </CardContent>
    </Card>
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
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Execution Status Panel
// ---------------------------------------------------------------------------

function ExecutionStatusPanel({
  result,
  error,
}: {
  result: ManualTradeRecord | null;
  error: string | null;
}) {
  if (!result && !error) {
    return (
      <Card data-testid="execution-status-panel">
        <CardHeader>
          <CardTitle className="text-base">Execution Status</CardTitle>
          <CardDescription>
            Place an order to see the live status here.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Awaiting order.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="execution-status-panel">
      <CardHeader>
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base">Execution Status</CardTitle>
            {result && (
              <CardDescription className="font-mono text-xs">
                {result.id}
              </CardDescription>
            )}
          </div>
          {result && (
            <Badge variant={statusVariant(result.status)}>
              {statusText(result.status)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && !result && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-sm">
            {error}
          </div>
        )}
        {result && (
          <>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Cell label="Master">{result.masterAccountName ?? result.masterAccountId}</Cell>
              <Cell label="Broker">{result.broker}</Cell>
              <Cell label="Symbol">{result.symbol}</Cell>
              <Cell label="Side">
                <Badge variant={sideVariant(result.side)}>{result.side}</Badge>
              </Cell>
              <Cell label="Order Type">{result.orderType}</Cell>
              <Cell label="Product">{result.product}</Cell>
              <Cell label="Quantity">{result.quantity}</Cell>
              <Cell label="Price">{result.price ?? '—'}</Cell>
              <Cell label="Trigger">{result.triggerPrice ?? '—'}</Cell>
              <Cell label="Validity">{result.validity}</Cell>
            </div>
            {result.brokerOrderId && (
              <div className="rounded-md border bg-muted/40 p-2 text-xs">
                <div className="text-muted-foreground uppercase tracking-wide text-[10px] mb-1">
                  Master broker order id
                </div>
                <div className="font-mono break-all">{result.brokerOrderId}</div>
              </div>
            )}
            <div className="grid grid-cols-4 gap-2 text-xs">
              <Tile label="Followers" value={result.followersFound} />
              <Tile
                label="Success"
                value={result.successfulFollowers}
                accent="emerald"
              />
              <Tile
                label="Failed"
                value={result.failedFollowers}
                accent="rose"
              />
              <Tile
                label="Skipped"
                value={result.skippedFollowers}
                accent="muted"
              />
            </div>
            {result.rejectionReason && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">
                <div className="text-muted-foreground uppercase tracking-wide text-[10px] mb-1">
                  Reason
                </div>
                <div>{result.rejectionReason}</div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Cell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Tile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: 'emerald' | 'rose' | 'muted';
}) {
  const cls =
    accent === 'emerald'
      ? 'text-emerald-600 dark:text-emerald-400'
      : accent === 'rose'
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-muted-foreground';
  return (
    <div className="rounded-md border p-2 text-center">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation Summary
// ---------------------------------------------------------------------------

function ValidationSummary({
  errors,
  record,
}: {
  errors: ManualTradeValidationCheck[] | null;
  record: ManualTradeRecord | null;
}) {
  const checks =
    record?.validation.checks ??
    (errors
      ? errors.map((e) => ({ ...e }))
      : []);

  if (!record && !errors) {
    return (
      <Card data-testid="validation-summary">
        <CardHeader>
          <CardTitle className="text-base">Validation Summary</CardTitle>
          <CardDescription>
            Pre-flight checks run before the master broker is contacted.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No trade placed yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="validation-summary">
      <CardHeader>
        <CardTitle className="text-base">Validation Summary</CardTitle>
        <CardDescription>
          {errors
            ? 'Validation blocked placement — fix the highlighted checks and retry.'
            : `Validated at ${fmtTime(record?.validation.validatedAt)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {checks.length === 0 ? (
          <div className="text-muted-foreground">No checks recorded.</div>
        ) : (
          checks.map((c) => (
            <div
              key={c.key}
              className="flex items-start gap-2"
              data-testid={`validation-${c.key}`}
            >
              {c.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              )}
              <div>
                <div className="font-mono text-[11px] uppercase text-muted-foreground">
                  {c.key.replace(/_/g, ' ')}
                </div>
                <div>{c.message}</div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Live Order Response Panel
// ---------------------------------------------------------------------------

function LiveOrderResponsePanel({
  record,
}: {
  record: ManualTradeRecord | null;
}) {
  if (!record) return null;
  return (
    <Card data-testid="live-order-response">
      <CardHeader>
        <CardTitle className="text-base">Live Order Response</CardTitle>
        <CardDescription>
          Verbatim master broker adapter payload
        </CardDescription>
      </CardHeader>
      <CardContent>
        {record.brokerResponse === null ? (
          <div className="text-sm text-muted-foreground">
            No broker response captured.
          </div>
        ) : (
          <pre className="rounded-md border bg-muted/40 p-2 overflow-x-auto text-[11px]">
            {formatResponse(record.brokerResponse)}
          </pre>
        )}
      </CardContent>
    </Card>
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
// Recent Orders Table
// ---------------------------------------------------------------------------

function RecentOrdersTable({ rows }: { rows: ManualTradeRecord[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Manual Orders</CardTitle>
        <CardDescription>
          In-memory ledger of admin-initiated master trades. Auto-refreshes
          every few seconds and syncs with the CopyTradingService fan-out
          result.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div
            className="p-6 text-sm text-muted-foreground"
            data-testid="manual-trading-empty"
          >
            No manual trades placed yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2">Time</th>
                  <th className="text-left px-3 py-2">Master</th>
                  <th className="text-left px-3 py-2">Strategy</th>
                  <th className="text-left px-3 py-2">Symbol</th>
                  <th className="text-left px-3 py-2">Side</th>
                  <th className="text-left px-3 py-2">Type</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-right px-3 py-2">Followers</th>
                  <th className="text-left px-3 py-2">Broker Order</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody data-testid="manual-trading-recent-body">
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t"
                    data-testid={`manual-trading-row-${row.id}`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {fmtTime(row.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      {row.masterAccountName ?? row.masterAccountId}
                    </td>
                    <td className="px-3 py-2">{row.strategyName ?? '—'}</td>
                    <td className="px-3 py-2 font-medium">{row.symbol}</td>
                    <td className="px-3 py-2">
                      <Badge variant={sideVariant(row.side)}>{row.side}</Badge>
                    </td>
                    <td className="px-3 py-2">{row.orderType}</td>
                    <td className="px-3 py-2 text-right">{row.quantity}</td>
                    <td className="px-3 py-2 text-right">
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {row.successfulFollowers}
                      </span>
                      {' / '}
                      <span className="text-destructive">
                        {row.failedFollowers}
                      </span>
                      {' / '}
                      <span className="text-muted-foreground">
                        {row.followersFound}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {row.brokerOrderId ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      <RowStatusBadge status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RowStatusBadge({ status }: { status: ManualTradeStatus }) {
  const Icon =
    status === 'COMPLETED'
      ? CheckCircle2
      : status === 'FAILED' || status === 'REJECTED'
      ? XCircle
      : status === 'PARTIAL'
      ? MinusCircle
      : Clock;
  return (
    <div className="flex items-center gap-1.5">
      <Icon
        className={
          status === 'COMPLETED'
            ? 'h-3.5 w-3.5 text-emerald-500'
            : status === 'FAILED' || status === 'REJECTED'
            ? 'h-3.5 w-3.5 text-destructive'
            : status === 'PARTIAL'
            ? 'h-3.5 w-3.5 text-amber-500'
            : 'h-3.5 w-3.5 text-muted-foreground'
        }
      />
      <Badge variant={statusVariant(status)}>{statusText(status)}</Badge>
    </div>
  );
}
