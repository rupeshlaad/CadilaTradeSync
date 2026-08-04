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
  type ManualInstrumentSearchRow,
  type ManualTradeMarketProtection,
  type ManualTradeOrderType,
  type ManualTradeProduct,
  type ManualTradeRecord,
  type ManualTradeSide,
  type ManualTradeStatus,
  type ManualTradeValidationCheck,
  type ManualTradeValidity,
  type PlaceManualTradePayload,
} from '@/lib/api';
import type { Broker, StrategyDto, TradingAccountDto } from '@cts/shared';
import { InstrumentSearch } from './instrument-search';
import {
  MARKET_PROTECTION_OPTIONS,
  getAllowedOrderTypes,
  getAllowedProducts,
  getDefaultProduct,
  isOrderTypeAllowed,
  isProductAllowed,
  supportsMarketProtection,
  toInstrumentContext,
  type InstrumentContext,
} from '@/lib/broker-rules';

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

const PRODUCT_LABELS: Record<ManualTradeProduct, string> = {
  MIS: 'MIS (Intraday)',
  CNC: 'CNC (Delivery)',
  NRML: 'NRML (Normal)',
};

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
  /** Sprint 5.4.2 — Zerodha MARKET orders only. */
  marketProtection: ManualTradeMarketProtection;
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
  marketProtection: 'AUTO',
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
  const [selectedInstrument, setSelectedInstrument] =
    useState<ManualInstrumentSearchRow | null>(null);
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
  const masterBroker: Broker | null =
    (activeMaster?.broker as Broker | undefined) ?? null;

  const needsPrice = form.orderType === 'LIMIT' || form.orderType === 'SL';
  const needsTrigger = form.orderType === 'SL' || form.orderType === 'SL-M';

  // Sprint 5.4.2 — Instrument context feeds every broker-aware rule:
  // default product, allowed products / order types, and whether
  // Market Protection is applicable.
  const instrumentContext: InstrumentContext | null = useMemo(() => {
    if (!masterBroker || !selectedInstrument) return null;
    return toInstrumentContext(masterBroker, selectedInstrument);
  }, [masterBroker, selectedInstrument]);

  const allowedProducts = useMemo<ManualTradeProduct[]>(
    () => (instrumentContext ? getAllowedProducts(instrumentContext) : ['CNC', 'MIS', 'NRML']),
    [instrumentContext],
  );
  const allowedOrderTypes = useMemo<ManualTradeOrderType[]>(
    () => (instrumentContext ? getAllowedOrderTypes(instrumentContext) : ORDER_TYPES.map((o) => o.value)),
    [instrumentContext],
  );
  const marketProtectionApplies =
    supportsMarketProtection(masterBroker) && form.orderType === 'MARKET';

  const productAllowed = instrumentContext
    ? isProductAllowed(instrumentContext, form.product)
    : true;
  const orderTypeAllowed = instrumentContext
    ? isOrderTypeAllowed(instrumentContext, form.orderType)
    : true;

  // Sprint 5.4.1 — Place Order is only enabled when the operator has
  // picked an instrument via the broker-scoped autocomplete. Free-text
  // symbols never satisfy this invariant.
  // Sprint 5.4.2 — additionally require a broker-valid product /
  // order-type combination so we never submit a broker-guaranteed
  // rejection.
  const canSubmit =
    !submitting &&
    !!form.masterAccountId &&
    !!form.strategyId &&
    !!selectedInstrument &&
    !!form.exchange &&
    !!form.symbol &&
    selectedInstrument.brokerSymbol === form.symbol &&
    !!form.quantity &&
    Number(form.quantity) > 0 &&
    productAllowed &&
    orderTypeAllowed &&
    (!needsPrice || (!!form.price && Number(form.price) > 0)) &&
    (!needsTrigger || (!!form.triggerPrice && Number(form.triggerPrice) > 0));

  // Reset the picker when the master account (and therefore its
  // broker) changes so we never carry a stale symbol from a different
  // broker's universe into the order form.
  useEffect(() => {
    if (!selectedInstrument) return;
    // If the master broker doesn't match the selection's broker
    // context (or the master account was cleared), drop the selection.
    if (!masterBroker) {
      setSelectedInstrument(null);
      setForm((prev) => ({ ...prev, symbol: '' }));
    }
    // We intentionally do NOT auto-clear on same-broker reselection —
    // if the operator swaps to another CONNECTED master account on
    // the same broker, the symbol is still valid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.masterAccountId]);

  const handleInstrumentSelect = useCallback(
    (row: ManualInstrumentSearchRow) => {
      setSelectedInstrument(row);
      setForm((prev) => {
        // Sprint 5.4.2 — Smart defaults based on the instrument's
        // broker + segment. If the operator already flipped the
        // product manually to something the new instrument allows,
        // preserve it; otherwise snap to the recommended default.
        const ctx = masterBroker
          ? toInstrumentContext(masterBroker, row)
          : null;
        const allowed = ctx
          ? getAllowedProducts(ctx)
          : (['CNC', 'MIS', 'NRML'] as ManualTradeProduct[]);
        const nextProduct: ManualTradeProduct = allowed.includes(prev.product)
          ? prev.product
          : ctx
          ? getDefaultProduct(ctx)
          : allowed[0] ?? prev.product;
        const orderTypesAllowed = ctx
          ? getAllowedOrderTypes(ctx)
          : ORDER_TYPES.map((o) => o.value);
        const nextOrderType: ManualTradeOrderType = orderTypesAllowed.includes(
          prev.orderType,
        )
          ? prev.orderType
          : orderTypesAllowed[0] ?? prev.orderType;
        return {
          ...prev,
          symbol: row.brokerSymbol,
          exchange: row.exchange,
          product: nextProduct,
          orderType: nextOrderType,
        };
      });
      // Clear stale validation banners from a previous submission.
      setValidationErrors(null);
      setPlacementError(null);
    },
    [masterBroker],
  );

  const handleInstrumentClear = useCallback(() => {
    setSelectedInstrument(null);
    setForm((prev) => ({ ...prev, symbol: '' }));
  }, []);

  const submit = async () => {
    if (!selectedInstrument) {
      // Belt-and-braces: the button is already disabled in this
      // state, but never allow a bypass — free-text symbols must
      // never reach the manual-trade API.
      setPlacementError(
        'Please select an instrument from the search results before placing an order.',
      );
      return;
    }
    setSubmitting(true);
    setValidationErrors(null);
    setPlacementError(null);
    setLastResult(null);
    try {
      const payload: PlaceManualTradePayload = {
        masterAccountId: form.masterAccountId,
        strategyId: form.strategyId,
        exchange: selectedInstrument.exchange,
        symbol: selectedInstrument.brokerSymbol,
        side: form.side,
        orderType: form.orderType,
        quantity: Number(form.quantity),
        product: form.product,
        validity: form.validity,
      };
      if (needsPrice) payload.price = Number(form.price);
      if (needsTrigger) payload.triggerPrice = Number(form.triggerPrice);
      // Sprint 5.4.2 — Only send Market Protection when it applies
      // (Zerodha + MARKET). The server also enforces this.
      if (marketProtectionApplies) {
        payload.marketProtection = form.marketProtection;
      }

      const res = await api.admin.manualTrading.place(payload);
      setLastResult(res);
      await loadRecent();
    } catch (e: any) {
      const body = e?.body ?? {};
      // The API returns the FULL manual-trade record on every failure
      // path so the UI can render exactly what the broker said without
      // any downstream lookup. Preserve it verbatim.
      if (body?.record) {
        setLastResult(body.record as ManualTradeRecord);
      }
      if (Array.isArray(body?.errors)) {
        setValidationErrors(body.errors as ManualTradeValidationCheck[]);
      }
      // Prefer the broker text over any generic HTTP status message —
      // the sprint explicitly requires the full broker rejection to
      // surface here.
      const brokerMessage =
        body?.brokerMessage ??
        body?.message ??
        e?.message ??
        'Failed to place manual trade';
      setPlacementError(brokerMessage);
      // Refresh the ledger so the newly-failed record shows up in the
      // Recent Orders table too (matches the sprint's "same reason
      // everywhere" requirement).
      loadRecent().catch(() => {});
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setForm(INITIAL_FORM);
    setSelectedInstrument(null);
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
            masterBroker={masterBroker}
            selectedInstrument={selectedInstrument}
            onInstrumentSelect={handleInstrumentSelect}
            onInstrumentClear={handleInstrumentClear}
            allowedProducts={allowedProducts}
            allowedOrderTypes={allowedOrderTypes}
            marketProtectionApplies={marketProtectionApplies}
            productAllowed={productAllowed}
            orderTypeAllowed={orderTypeAllowed}
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
  masterBroker,
  selectedInstrument,
  onInstrumentSelect,
  onInstrumentClear,
  allowedProducts,
  allowedOrderTypes,
  marketProtectionApplies,
  productAllowed,
  orderTypeAllowed,
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
  masterBroker: Broker | null;
  selectedInstrument: ManualInstrumentSearchRow | null;
  onInstrumentSelect: (row: ManualInstrumentSearchRow) => void;
  onInstrumentClear: () => void;
  allowedProducts: ManualTradeProduct[];
  allowedOrderTypes: ManualTradeOrderType[];
  marketProtectionApplies: boolean;
  productAllowed: boolean;
  orderTypeAllowed: boolean;
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
            {selectedInstrument ? (
              <div
                className="flex h-10 w-full items-center rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground"
                data-testid="field-exchange-readonly"
              >
                <span className="font-mono">{selectedInstrument.exchange}</span>
                <span className="ml-2 text-[11px] uppercase tracking-wide">
                  · {selectedInstrument.segment}
                </span>
              </div>
            ) : (
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
            )}
          </Field>

          <div>
            <InstrumentSearch
              broker={masterBroker}
              selected={selectedInstrument}
              onSelect={onInstrumentSelect}
              onClear={onInstrumentClear}
              disabled={!masterBroker}
            />
            {selectedInstrument && (
              <div
                className="mt-1 text-[11px] text-muted-foreground grid grid-cols-2 gap-x-3"
                data-testid="instrument-search-meta"
              >
                <span>
                  Broker symbol:{' '}
                  <span
                    className="font-mono text-foreground"
                    data-testid="instrument-search-broker-symbol"
                  >
                    {selectedInstrument.brokerSymbol}
                  </span>
                </span>
                <span>
                  Lot size:{' '}
                  <span
                    className="font-mono text-foreground"
                    data-testid="instrument-search-lot-size"
                  >
                    {selectedInstrument.lotSize}
                  </span>
                </span>
                {selectedInstrument.tickSize != null && (
                  <span>
                    Tick size:{' '}
                    <span
                      className="font-mono text-foreground"
                      data-testid="instrument-search-tick-size"
                    >
                      {selectedInstrument.tickSize}
                    </span>
                  </span>
                )}
                {selectedInstrument.expiry && (
                  <span>
                    Expiry:{' '}
                    <span className="font-mono text-foreground">
                      {selectedInstrument.expiry.substring(0, 10)}
                    </span>
                  </span>
                )}
                {selectedInstrument.strike != null && (
                  <span>
                    Strike:{' '}
                    <span className="font-mono text-foreground">
                      {selectedInstrument.strike}
                      {selectedInstrument.optionType
                        ? ` ${selectedInstrument.optionType}`
                        : ''}
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>

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
              {ORDER_TYPES.filter((o) => allowedOrderTypes.includes(o.value)).map(
                (o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ),
              )}
            </Select>
            {!orderTypeAllowed && (
              <div
                className="text-[11px] text-destructive mt-1"
                data-testid="order-type-invalid-warning"
              >
                {form.orderType} is not accepted on{' '}
                {selectedInstrument?.segment ?? 'this segment'} for{' '}
                {masterBroker}. Allowed: {allowedOrderTypes.join(', ')}
              </div>
            )}
            {masterBroker === 'ZERODHA' && form.orderType === 'MARKET' && (
              <div
                className="text-[11px] text-muted-foreground mt-1"
                data-testid="market-protection-hint"
              >
                Zerodha applies market protection to MARKET orders — select a
                cap below.
              </div>
            )}
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
              {allowedProducts.map((p) => (
                <option key={p} value={p}>
                  {PRODUCT_LABELS[p]}
                </option>
              ))}
            </Select>
            {selectedInstrument && (
              <div
                className="text-[11px] text-muted-foreground mt-1"
                data-testid="product-hint"
              >
                {productAllowed
                  ? `Recommended for ${selectedInstrument.segment}: ${allowedProducts[0]}`
                  : `${form.product} not accepted on ${selectedInstrument.segment}. Allowed: ${allowedProducts.join(', ')}`}
              </div>
            )}
          </Field>

          <Field label={needsPrice ? 'Price (required)' : 'Price'}>
            <Input
              type="number"
              min={0}
              step="0.05"
              placeholder="Limit / SL price"
              value={form.price}
              onChange={(e) => patch({ price: e.target.value })}
              disabled={!needsPrice}
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
              disabled={!needsTrigger}
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

          {marketProtectionApplies && (
            <Field label="Market Protection">
              <Select
                value={form.marketProtection}
                onChange={(e) =>
                  patch({
                    marketProtection: e.target
                      .value as ManualTradeMarketProtection,
                  })
                }
                data-testid="field-market-protection"
              >
                {MARKET_PROTECTION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <div className="text-[11px] text-muted-foreground mt-1">
                Zerodha caps how far a MARKET order can slip from LTP.
              </div>
            </Field>
          )}
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
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-sm whitespace-pre-wrap break-words">
            {error}
          </div>
        )}
        {result && (
          <>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Cell label="Status">
                <Badge variant={statusVariant(result.status)}>
                  {statusText(result.status)}
                </Badge>
              </Cell>
              <Cell label="Failure Type">
                {result.failureType ? (
                  <Badge variant="destructive" className="uppercase">
                    {result.failureType.replace(/_/g, ' ')}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Cell>
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
              {result.marketProtection && (
                <Cell label="Market Protection">
                  {result.marketProtection}
                </Cell>
              )}
              <Cell label="Timestamp">{fmtTime(result.updatedAt)}</Cell>
              {result.failureStage && (
                <Cell label="Failure Stage">
                  <span className="font-mono text-[11px] uppercase">
                    {result.failureStage.replace(/_/g, ' ')}
                  </span>
                </Cell>
              )}
            </div>
            {result.brokerOrderId && (
              <div className="rounded-md border bg-muted/40 p-2 text-xs">
                <div className="text-muted-foreground uppercase tracking-wide text-[10px] mb-1">
                  Master broker order id
                </div>
                <div className="font-mono break-all">{result.brokerOrderId}</div>
              </div>
            )}
            {result.rejectionReason && (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs"
                data-testid="broker-rejection-reason"
              >
                <div className="text-muted-foreground uppercase tracking-wide text-[10px] mb-1">
                  Broker Message
                </div>
                <div className="whitespace-pre-wrap break-words text-destructive">
                  {result.rejectionReason}
                </div>
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
  const preflightChecks =
    record?.validation.checks ??
    (errors ? errors.map((e) => ({ ...e })) : []);

  // Stage-level rollup so operators see a top-to-bottom picture of
  // exactly where the trade fell over — pre-flight, broker placement,
  // fan-out — even when a downstream stage fails after every pre-flight
  // check passed.
  const stages = buildStageChecks(record, preflightChecks);

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
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Pipeline stages
          </div>
          {stages.map((s) => (
            <div
              key={s.key}
              className="flex items-start gap-2"
              data-testid={`stage-${s.key}`}
            >
              {s.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              )}
              <div className="flex-1">
                <div className="font-medium text-sm">{s.label}</div>
                {s.detail && (
                  <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                    {s.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {preflightChecks.length > 0 && (
          <div className="space-y-1.5 border-t pt-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Pre-flight checks
            </div>
            {preflightChecks.map((c) => (
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
                  <div className="whitespace-pre-wrap break-words">
                    {c.message}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface StageCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string | null;
}

/**
 * Roll pre-flight + broker-placement + fan-out into a single
 * stage-by-stage view. The sprint explicitly asks for a "which stage
 * failed" breakdown; this function computes it deterministically from
 * the manual-trade record + local validation errors.
 */
function buildStageChecks(
  record: ManualTradeRecord | null,
  preflightChecks: ManualTradeValidationCheck[],
): StageCheck[] {
  const stages: StageCheck[] = [];

  // 1) Local validation — the DTO-level shape/required-field check.
  //    Anything reaching preflightChecks with content means the local
  //    ValidationPipe already accepted the payload.
  stages.push({
    key: 'local_validation',
    label: 'Local validation',
    ok: true,
    detail: 'Form payload passed shape / required-field validation',
  });

  // 2) Strategy validation — resolves to true iff every strategy-scoped
  //    pre-flight check succeeded.
  const strategyKeys = [
    'strategy_active',
    'strategy_belongs_to_master',
    'strategy_has_enabled_followers',
    'instrument_exists',
    'broker_symbol_mapping_exists',
    'required_fields_present',
  ];
  const strategyChecks = preflightChecks.filter((c) => strategyKeys.includes(c.key));
  const strategyFail = strategyChecks.find((c) => !c.ok) ?? null;
  stages.push({
    key: 'strategy_validation',
    label: 'Strategy validation',
    ok: strategyChecks.length > 0 ? !strategyFail : true,
    detail: strategyFail ? strategyFail.message : null,
  });

  // 3) Master session — connection + broker session health.
  const sessionKeys = [
    'master_account_exists',
    'master_account_connected',
    'broker_session_healthy',
  ];
  const sessionChecks = preflightChecks.filter((c) => sessionKeys.includes(c.key));
  const sessionFail = sessionChecks.find((c) => !c.ok) ?? null;
  stages.push({
    key: 'master_session',
    label: 'Master session',
    ok: sessionChecks.length > 0 ? !sessionFail : true,
    detail: sessionFail ? sessionFail.message : null,
  });

  // 4) Broker order placement — only relevant if pre-flight succeeded.
  const preflightOk = preflightChecks.every((c) => c.ok);
  if (!preflightOk) {
    stages.push({
      key: 'broker_order_placement',
      label: 'Broker order placement',
      ok: false,
      detail: 'Skipped — pre-flight validation failed',
    });
  } else if (!record) {
    stages.push({
      key: 'broker_order_placement',
      label: 'Broker order placement',
      ok: false,
      detail: null,
    });
  } else if (record.failureStage === 'broker_placement' || record.failureStage === 'broker_error') {
    stages.push({
      key: 'broker_order_placement',
      label: 'Broker order placement',
      ok: false,
      detail: record.rejectionReason,
    });
  } else if (record.brokerOrderId) {
    stages.push({
      key: 'broker_order_placement',
      label: 'Broker order placement',
      ok: true,
      detail: `Broker accepted order ${record.brokerOrderId}`,
    });
  } else {
    stages.push({
      key: 'broker_order_placement',
      label: 'Broker order placement',
      ok: false,
      detail: record.rejectionReason,
    });
  }

  return stages;
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
                    className="border-t align-top"
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
                    <td className="px-3 py-2 max-w-xs">
                      <RowStatusBadge status={row.status} />
                      {row.rejectionReason && (
                        <div
                          className="text-[11px] text-destructive whitespace-pre-wrap break-words mt-1"
                          data-testid={`row-reason-${row.id}`}
                        >
                          {row.rejectionReason}
                        </div>
                      )}
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
