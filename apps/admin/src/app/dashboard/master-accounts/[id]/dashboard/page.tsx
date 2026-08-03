'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, RefreshCw, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { BROKER_LABELS, ConnectionStatus, type TradingAccountDto } from '@cts/shared';

// ---------- Response types (kept local to avoid touching shared package) ----------

type SectionError = string | null;

interface DashboardHealth {
  connected: boolean;
  connectionStatus: ConnectionStatus;
  lastHeartbeat: string | null;
  loginTime: string;
}

interface BrokerProfile {
  broker: string;
  userId: string;
  userName: string;
  email?: string;
}

interface DashboardResponse {
  profile: BrokerProfile | null;
  margins: any | null;
  holdings: any[] | null;
  positions: { net?: any[]; day?: any[] } | any[] | null;
  orders: any[] | null;
  trades: any[] | null;
  errors: {
    profile: SectionError;
    margins: SectionError;
    holdings: SectionError;
    positions: SectionError;
    orders: SectionError;
    trades: SectionError;
  };
  health: DashboardHealth;
}

// ---------- Helpers ----------

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function fmtNum(v: any, digits = 2): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function extractPositions(p: DashboardResponse['positions']): any[] {
  if (!p) return [];
  if (Array.isArray(p)) return p;
  return p.net ?? p.day ?? [];
}

function extractMarginsSegments(m: any): Array<{ segment: string; row: any }> {
  if (!m || typeof m !== 'object') return [];
  const out: Array<{ segment: string; row: any }> = [];
  for (const key of Object.keys(m)) {
    const row = m[key];
    if (row && typeof row === 'object') out.push({ segment: key, row });
  }
  return out;
}

// ---------- Small UI atoms ----------

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        ok ? 'bg-emerald-500' : 'bg-destructive'
      }`}
      aria-hidden
    />
  );
}

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const variant =
    status === ConnectionStatus.CONNECTED
      ? 'success'
      : status === ConnectionStatus.CONNECTING
      ? 'warning'
      : status === ConnectionStatus.ERROR
      ? 'destructive'
      : 'muted';
  return <Badge variant={variant as any}>{status}</Badge>;
}

function SectionCard({
  title,
  description,
  error,
  count,
  children,
  testid,
}: {
  title: string;
  description?: string;
  error?: SectionError;
  count?: number | null;
  children: React.ReactNode;
  testid: string;
}) {
  return (
    <Card data-testid={testid}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-lg">{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {count !== undefined && count !== null && (
              <Badge variant="secondary">{count}</Badge>
            )}
            {error ? (
              <Badge variant="destructive" className="gap-1">
                <XCircle className="h-3 w-3" /> Failed
              </Badge>
            ) : (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3 w-3" /> OK
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

function DataTable({
  columns,
  rows,
  emptyLabel,
}: {
  columns: Array<{ key: string; label: string; align?: 'left' | 'right'; render?: (row: any) => React.ReactNode }>;
  rows: any[];
  emptyLabel: string;
}) {
  if (!rows || rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">{emptyLabel}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground border-b">
            {columns.map((c) => (
              <th
                key={c.key}
                className={`py-2 pr-4 font-medium ${c.align === 'right' ? 'text-right' : ''}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b last:border-none">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`py-2 pr-4 ${c.align === 'right' ? 'text-right font-mono' : ''}`}
                >
                  {c.render ? c.render(row) : row?.[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Page ----------

export default function MasterDashboardPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [account, setAccount] = useState<TradingAccountDto | null>(null);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(initial = false) {
    if (!id) return;
    try {
      if (initial) setLoading(true);
      else setRefreshing(true);
      setError(null);
      const [acc, dash] = await Promise.all([
        api.admin.masterAccounts.get(id),
        api.admin.masterAccounts.dashboard(id) as Promise<DashboardResponse>,
      ]);
      setAccount(acc);
      setData(dash);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const positionsRows = useMemo(() => extractPositions(data?.positions ?? null), [data?.positions]);
  const marginsRows = useMemo(() => extractMarginsSegments(data?.margins), [data?.margins]);

  return (
    <div className="space-y-6" data-testid="master-dashboard-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <Button variant="ghost" size="sm" asChild className="-ml-3">
            <Link href="/dashboard/master-accounts" data-testid="back-to-master-accounts">
              <ArrowLeft className="h-4 w-4" /> Back to master accounts
            </Link>
          </Button>
          <h2 className="text-2xl font-bold">
            {account ? account.nickname : 'Master Dashboard'}
          </h2>
          <p className="text-muted-foreground text-sm">
            {account ? (
              <>
                <span>{BROKER_LABELS[account.broker]}</span>
                <span className="mx-2">·</span>
                <span className="font-mono">{account.clientId}</span>
              </>
            ) : (
              'Loading account…'
            )}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => load(false)}
          disabled={loading || refreshing}
          data-testid="refresh-dashboard"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {error && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Failed to load dashboard</p>
                <p className="text-muted-foreground">{error}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {loading && !data && (
        <Card>
          <CardContent className="pt-6 text-muted-foreground">Loading dashboard…</CardContent>
        </Card>
      )}

      {data && (
        <>
          {/* Connection Status */}
          <Card data-testid="section-connection-status">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Connection Status</CardTitle>
              <CardDescription>Live session and broker connectivity</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Live</p>
                  <div className="flex items-center gap-2">
                    <StatusDot ok={data.health.connected} />
                    <span className="text-sm font-medium">
                      {data.health.connected ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
                  <ConnectionBadge status={data.health.connectionStatus} />
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Login Time</p>
                  <p className="text-sm font-mono">{fmtDate(data.health.loginTime)}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Last Heartbeat</p>
                  <p className="text-sm font-mono">{fmtDate(data.health.lastHeartbeat)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Profile & Margins side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <SectionCard
              title="Profile"
              description="Broker account holder"
              error={data.errors.profile}
              testid="section-profile"
            >
              {data.profile ? (
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">User Name</p>
                    <p className="font-medium">{data.profile.userName || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">User ID</p>
                    <p className="font-mono">{data.profile.userId || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Broker</p>
                    <p>{data.profile.broker}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Email</p>
                    <p className="break-all">{data.profile.email || '—'}</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No profile returned.</p>
              )}
            </SectionCard>

            <SectionCard
              title="Margins"
              description="Available funds by segment"
              error={data.errors.margins}
              testid="section-margins"
            >
              {marginsRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No margins returned.</p>
              ) : (
                <div className="space-y-4">
                  {marginsRows.map(({ segment, row }) => {
                    const available = row?.available?.live_balance ?? row?.available?.cash ?? row?.net ?? row?.available;
                    const used =
                      row?.utilised?.debits ??
                      row?.utilised?.total ??
                      row?.used ??
                      row?.utilised;
                    const net = row?.net ?? row?.available?.live_balance;
                    return (
                      <div key={segment} className="rounded-md border p-3">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-sm font-medium uppercase tracking-wide">{segment}</p>
                          <Badge variant="muted">{segment}</Badge>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-sm">
                          <div>
                            <p className="text-xs text-muted-foreground">Available</p>
                            <p className="font-mono">
                              {typeof available === 'number' || typeof available === 'string'
                                ? fmtNum(available)
                                : '—'}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Used</p>
                            <p className="font-mono">
                              {typeof used === 'number' || typeof used === 'string' ? fmtNum(used) : '—'}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Net</p>
                            <p className="font-mono">
                              {typeof net === 'number' || typeof net === 'string' ? fmtNum(net) : '—'}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SectionCard>
          </div>

          {/* Holdings */}
          <SectionCard
            title="Holdings"
            description="Long-term equity holdings"
            error={data.errors.holdings}
            count={data.holdings?.length ?? null}
            testid="section-holdings"
          >
            <DataTable
              rows={data.holdings ?? []}
              emptyLabel="No holdings."
              columns={[
                { key: 'tradingsymbol', label: 'Symbol', render: (r) => <span className="font-mono">{r.tradingsymbol ?? r.symbol ?? '—'}</span> },
                { key: 'exchange', label: 'Exch' },
                { key: 'quantity', label: 'Qty', align: 'right', render: (r) => fmtNum(r.quantity ?? r.qty, 0) },
                { key: 'average_price', label: 'Avg', align: 'right', render: (r) => fmtNum(r.average_price ?? r.avgPrice) },
                { key: 'last_price', label: 'LTP', align: 'right', render: (r) => fmtNum(r.last_price ?? r.ltp) },
                {
                  key: 'pnl',
                  label: 'P&L',
                  align: 'right',
                  render: (r) => {
                    const v = r.pnl ?? r.profit_and_loss;
                    const n = typeof v === 'number' ? v : Number(v);
                    if (!Number.isFinite(n)) return '—';
                    return (
                      <span className={n >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                        {fmtNum(n)}
                      </span>
                    );
                  },
                },
              ]}
            />
          </SectionCard>

          {/* Positions */}
          <SectionCard
            title="Positions"
            description="Open intraday and net positions"
            error={data.errors.positions}
            count={positionsRows.length}
            testid="section-positions"
          >
            <DataTable
              rows={positionsRows}
              emptyLabel="No open positions."
              columns={[
                { key: 'tradingsymbol', label: 'Symbol', render: (r) => <span className="font-mono">{r.tradingsymbol ?? r.symbol ?? '—'}</span> },
                { key: 'exchange', label: 'Exch' },
                { key: 'product', label: 'Product' },
                { key: 'quantity', label: 'Qty', align: 'right', render: (r) => fmtNum(r.quantity ?? r.net_quantity, 0) },
                { key: 'average_price', label: 'Avg', align: 'right', render: (r) => fmtNum(r.average_price ?? r.buy_price) },
                { key: 'last_price', label: 'LTP', align: 'right', render: (r) => fmtNum(r.last_price ?? r.ltp) },
                {
                  key: 'pnl',
                  label: 'P&L',
                  align: 'right',
                  render: (r) => {
                    const v = r.pnl ?? r.profit_loss;
                    const n = typeof v === 'number' ? v : Number(v);
                    if (!Number.isFinite(n)) return '—';
                    return (
                      <span className={n >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                        {fmtNum(n)}
                      </span>
                    );
                  },
                },
              ]}
            />
          </SectionCard>

          {/* Orders */}
          <SectionCard
            title="Orders"
            description="Today's order book"
            error={data.errors.orders}
            count={data.orders?.length ?? null}
            testid="section-orders"
          >
            <DataTable
              rows={data.orders ?? []}
              emptyLabel="No orders."
              columns={[
                { key: 'order_id', label: 'Order ID', render: (r) => <span className="font-mono text-xs">{r.order_id ?? r.orderId ?? '—'}</span> },
                { key: 'tradingsymbol', label: 'Symbol', render: (r) => <span className="font-mono">{r.tradingsymbol ?? r.symbol ?? '—'}</span> },
                {
                  key: 'transaction_type',
                  label: 'Side',
                  render: (r) => {
                    const t = r.transaction_type ?? r.side;
                    if (!t) return '—';
                    return (
                      <Badge variant={t === 'BUY' ? 'success' : 'destructive'}>{t}</Badge>
                    );
                  },
                },
                { key: 'quantity', label: 'Qty', align: 'right', render: (r) => fmtNum(r.quantity, 0) },
                { key: 'price', label: 'Price', align: 'right', render: (r) => fmtNum(r.price) },
                {
                  key: 'status',
                  label: 'Status',
                  render: (r) => {
                    const s = String(r.status ?? '—');
                    const variant =
                      s === 'COMPLETE'
                        ? 'success'
                        : s === 'REJECTED' || s === 'CANCELLED'
                        ? 'destructive'
                        : s === 'OPEN' || s === 'TRIGGER PENDING'
                        ? 'warning'
                        : 'muted';
                    return <Badge variant={variant as any}>{s}</Badge>;
                  },
                },
              ]}
            />
          </SectionCard>

          {/* Trades */}
          <SectionCard
            title="Trades"
            description="Executed trades today"
            error={data.errors.trades}
            count={data.trades?.length ?? null}
            testid="section-trades"
          >
            <DataTable
              rows={data.trades ?? []}
              emptyLabel="No trades executed today."
              columns={[
                { key: 'trade_id', label: 'Trade ID', render: (r) => <span className="font-mono text-xs">{r.trade_id ?? r.tradeId ?? '—'}</span> },
                { key: 'tradingsymbol', label: 'Symbol', render: (r) => <span className="font-mono">{r.tradingsymbol ?? r.symbol ?? '—'}</span> },
                {
                  key: 'transaction_type',
                  label: 'Side',
                  render: (r) => {
                    const t = r.transaction_type ?? r.side;
                    if (!t) return '—';
                    return (
                      <Badge variant={t === 'BUY' ? 'success' : 'destructive'}>{t}</Badge>
                    );
                  },
                },
                { key: 'quantity', label: 'Qty', align: 'right', render: (r) => fmtNum(r.quantity, 0) },
                { key: 'average_price', label: 'Price', align: 'right', render: (r) => fmtNum(r.average_price ?? r.price) },
                { key: 'exchange_timestamp', label: 'Time', render: (r) => fmtDate(r.exchange_timestamp ?? r.fill_timestamp ?? r.order_timestamp ?? null) },
              ]}
            />
          </SectionCard>
        </>
      )}
    </div>
  );
}
