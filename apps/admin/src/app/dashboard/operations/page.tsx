'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Server,
  Users,
  ListChecks,
  Copy,
  XCircle,
  AlertTriangle,
  Clock,
  RefreshCw,
} from 'lucide-react';

import { api } from '@/lib/api';
import type {
  ExecutionHistoryRow,
  ExecutionHistorySummary,
  ManualTradeRecord,
} from '@/lib/api';
import { ConnectionStatus, type FollowerDto, type TradingAccountDto } from '@cts/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Sprint 6.4 — Enterprise Operations Dashboard (Phase 1, READ ONLY).
 *
 * Consumes ONLY existing admin read APIs. No backend/logic changes. Any value
 * the API cannot supply renders as "No Data" (never fabricated).
 */

const NO_DATA = 'No Data';

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return NO_DATA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NO_DATA;
  return d.toLocaleString();
}

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? NO_DATA : String(v);
}

// Map broker ConnectionStatus -> required health label + color-coded badge.
function statusBadge(status: ConnectionStatus | string) {
  const map: Record<string, { label: string; cls: string; dot: string }> = {
    CONNECTED: { label: 'Connected', cls: 'bg-green-500/15 text-green-500 border-green-500/30', dot: 'bg-green-500' },
    DISCONNECTED: { label: 'Disconnected', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30', dot: 'bg-slate-400' },
    EXPIRED: { label: 'Session Expired', cls: 'bg-amber-500/15 text-amber-500 border-amber-500/30', dot: 'bg-amber-500' },
    ERROR: { label: 'Authentication Failed', cls: 'bg-red-500/15 text-red-500 border-red-500/30', dot: 'bg-red-500' },
    CONNECTING: { label: 'Connecting', cls: 'bg-blue-500/15 text-blue-500 border-blue-500/30', dot: 'bg-blue-500' },
  };
  const s = map[String(status)] ?? { label: String(status || NO_DATA), cls: 'bg-muted text-muted-foreground border-border', dot: 'bg-muted-foreground' };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function orderStatusBadge(status: string) {
  const s = String(status || '').toUpperCase();
  let cls = 'bg-muted text-muted-foreground border-border';
  if (/(COMPLETE|SUCCESS|FILLED|OK)/.test(s)) cls = 'bg-green-500/15 text-green-500 border-green-500/30';
  else if (/(REJECT|FAIL|ERROR|CANCEL)/.test(s)) cls = 'bg-red-500/15 text-red-500 border-red-500/30';
  else if (/(PENDING|OPEN|PARTIAL|PLACED|SUBMIT|TRIGGER)/.test(s)) cls = 'bg-amber-500/15 text-amber-500 border-amber-500/30';
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{status || NO_DATA}</span>;
}

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  testId: string;
  accent?: 'default' | 'danger' | 'warning';
}
function StatCard({ label, value, icon, testId, accent = 'default' }: StatCardProps) {
  const valueCls =
    accent === 'danger' ? 'text-red-500' : accent === 'warning' ? 'text-amber-500' : 'text-foreground';
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <CardDescription>{label}</CardDescription>
        <span className="text-primary">{icon}</span>
      </CardHeader>
      <CardContent>
        <div className={`text-3xl font-bold ${valueCls}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

export default function OperationsDashboard() {
  const [masters, setMasters] = useState<TradingAccountDto[] | null>(null);
  const [followers, setFollowers] = useState<FollowerDto[] | null>(null);
  const [summary, setSummary] = useState<ExecutionHistorySummary | null>(null);
  const [copyTrades, setCopyTrades] = useState<ExecutionHistoryRow[] | null>(null);
  const [orders, setOrders] = useState<ManualTradeRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Each source is independent — a failure in one must not blank the rest.
    const [m, f, s, c, o] = await Promise.allSettled([
      api.admin.masterAccounts.list(),
      api.admin.followers.list(),
      api.admin.executionHistory.summary(),
      api.admin.executionHistory.list({ limit: 10 }),
      api.admin.manualTrading.recent(15),
    ]);
    setMasters(m.status === 'fulfilled' ? m.value : null);
    setFollowers(f.status === 'fulfilled' ? f.value : null);
    setSummary(s.status === 'fulfilled' ? s.value : null);
    setCopyTrades(c.status === 'fulfilled' ? c.value.items : null);
    setOrders(o.status === 'fulfilled' ? o.value.items : null);
    if ([m, f, s, c, o].every((r) => r.status === 'rejected')) {
      setError('Failed to load operations data.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connectedBrokers = masters?.filter((a) => a.connectionStatus === ConnectionStatus.CONNECTED).length ?? null;
  const activeMasters = masters?.filter((a) => a.enabled).length ?? null;
  const activeFollowers = followers?.filter((a) => a.enabled).length ?? null;
  const lastSync =
    masters && masters.length > 0
      ? masters
          .map((a) => a.lastHeartbeat)
          .filter((x): x is string => !!x)
          .sort()
          .slice(-1)[0] ?? null
      : null;

  return (
    <div className="space-y-6" data-testid="operations-dashboard">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Operations Dashboard</h2>
          <p className="text-muted-foreground">Live health, orders and copy-trading across all brokers.</p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading} data-testid="ops-refresh-btn">
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {error && <div className="text-sm text-destructive" data-testid="ops-error">{error}</div>}

      {/* KPI cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard testId="ops-card-connected-brokers" label="Connected Brokers" value={num(connectedBrokers)} icon={<Server className="h-4 w-4" />} />
        <StatCard testId="ops-card-active-masters" label="Active Master Accounts" value={num(activeMasters)} icon={<Activity className="h-4 w-4" />} />
        <StatCard testId="ops-card-active-followers" label="Active Followers" value={num(activeFollowers)} icon={<Users className="h-4 w-4" />} />
        <StatCard testId="ops-card-orders-today" label="Orders Today" value={num(summary?.today.trades)} icon={<ListChecks className="h-4 w-4" />} />
        <StatCard testId="ops-card-copy-trades-today" label="Copy Trades Today" value={num(summary?.today.followersExecuted)} icon={<Copy className="h-4 w-4" />} />
        <StatCard testId="ops-card-failed-orders" label="Failed Orders" value={num(summary?.today.failed)} icon={<XCircle className="h-4 w-4" />} accent="danger" />
        <StatCard testId="ops-card-broker-errors" label="Broker Errors" value={num(summary?.today.errors)} icon={<AlertTriangle className="h-4 w-4" />} accent="warning" />
        <StatCard testId="ops-card-last-sync" label="Last Synchronization Time" value={fmtTime(lastSync)} icon={<Clock className="h-4 w-4" />} />
      </div>

      {/* Broker Health Panel */}
      <Card data-testid="ops-broker-health">
        <CardHeader>
          <CardTitle className="text-base">Broker Health</CardTitle>
          <CardDescription>Connection status per master account.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Broker</th>
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium">Connection Status</th>
                  <th className="px-4 py-2 font-medium">Last Successful Sync</th>
                  <th className="px-4 py-2 font-medium">Last Error</th>
                  <th className="px-4 py-2 font-medium">API Response Time</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>
                ) : !masters || masters.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">{NO_DATA}</td></tr>
                ) : (
                  masters.map((a) => (
                    <tr key={a.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-3 font-medium">{a.broker}</td>
                      <td className="px-4 py-3">{a.nickname || a.clientId || NO_DATA}</td>
                      <td className="px-4 py-3">{statusBadge(a.connectionStatus)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{fmtTime(a.lastHeartbeat)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{NO_DATA}</td>
                      <td className="px-4 py-3 text-muted-foreground">{NO_DATA}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Order Monitor */}
      <Card data-testid="ops-order-monitor">
        <CardHeader>
          <CardTitle className="text-base">Order Monitor</CardTitle>
          <CardDescription>Most recent orders placed through the platform.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Broker</th>
                  <th className="px-4 py-2 font-medium">Order ID</th>
                  <th className="px-4 py-2 font-medium">Symbol</th>
                  <th className="px-4 py-2 font-medium">Side</th>
                  <th className="px-4 py-2 font-medium">Qty</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>
                ) : !orders || orders.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">{NO_DATA}</td></tr>
                ) : (
                  orders.map((o) => (
                    <tr key={o.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-3 font-medium">{o.broker}</td>
                      <td className="px-4 py-3 font-mono text-xs">{o.brokerOrderId || NO_DATA}</td>
                      <td className="px-4 py-3">{o.symbol}</td>
                      <td className="px-4 py-3">
                        <span className={o.side === 'BUY' ? 'text-green-500' : 'text-red-500'}>{o.side}</span>
                      </td>
                      <td className="px-4 py-3">{o.quantity}</td>
                      <td className="px-4 py-3">{orderStatusBadge(o.status)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{fmtTime(o.createdAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Copy Trading Monitor */}
      <Card data-testid="ops-copy-monitor">
        <CardHeader>
          <CardTitle className="text-base">Copy Trading Monitor</CardTitle>
          <CardDescription>Master order → follower execution outcomes.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Master Order</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Followers</th>
                  <th className="px-4 py-2 font-medium">Completed</th>
                  <th className="px-4 py-2 font-medium">Rejected</th>
                  <th className="px-4 py-2 font-medium">Pending</th>
                  <th className="px-4 py-2 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>
                ) : !copyTrades || copyTrades.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">{NO_DATA}</td></tr>
                ) : (
                  copyTrades.map((r) => {
                    const pending = Math.max(
                      0,
                      r.totalFollowers - r.successfulFollowers - r.failedFollowers - r.skippedFollowers,
                    );
                    return (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            {r.masterBroker} · {r.masterSymbol}{' '}
                            <span className={r.masterSide === 'BUY' ? 'text-green-500' : 'text-red-500'}>{r.masterSide}</span>
                          </div>
                          <div className="text-xs text-muted-foreground">Qty {r.masterQuantity}</div>
                        </td>
                        <td className="px-4 py-3">{orderStatusBadge(r.status)}</td>
                        <td className="px-4 py-3">{r.totalFollowers}</td>
                        <td className="px-4 py-3 text-green-500">{r.successfulFollowers}</td>
                        <td className="px-4 py-3 text-red-500">{r.failedFollowers}</td>
                        <td className="px-4 py-3 text-amber-500">{pending + r.skippedFollowers}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtTime(r.timestamp)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
