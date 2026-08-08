'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  RefreshCw,
  RefreshCcw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  PlugZap,
  ShieldAlert,
} from 'lucide-react';
import { BrokerDashboardPanel } from '@cts/ui';
import type { MasterSyncResult } from '@/lib/api';
import {
  BROKER_LABELS,
  ConnectionStatus,
  type BrokerDashboardDto,
  type BrokerDashboardSection,
  type TradingAccountDto,
} from '@cts/shared';

/**
 * Sprint 6.2.4 — Master Portal broker dashboard.
 *
 * Now renders the SAME shared `BrokerDashboardPanel` the Follower Portal uses,
 * fed by the SAME normalized `BrokerDashboardDto`
 * (GET /admin/master-accounts/:id/dashboard → BrokerService.getBrokerDashboard).
 * There is no portal-specific broker mapping anymore: every value (profile,
 * funds, portfolio, holdings, positions, orders, trades) is normalized once in
 * BrokerService and rendered identically in both portals for every broker.
 */

type RefreshTarget = BrokerDashboardSection | 'all' | 'session' | null;

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-destructive'}`}
      aria-hidden
    />
  );
}

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const variant =
    status === ConnectionStatus.CONNECTED
      ? 'success'
      : status === ConnectionStatus.CONNECTING || status === ConnectionStatus.EXPIRED
      ? 'warning'
      : status === ConnectionStatus.ERROR
      ? 'destructive'
      : 'muted';
  return <Badge variant={variant as any} data-testid="connection-status-badge">{status}</Badge>;
}

export default function MasterDashboardPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [account, setAccount] = useState<TradingAccountDto | null>(null);
  const [data, setData] = useState<BrokerDashboardDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<RefreshTarget>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  // Sprint 6.2.13 — Manual Broker Sync ("Sync Broker") state.
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<MasterSyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function load(initial = false) {
    if (!id) return;
    try {
      if (initial) setLoading(true);
      else setRefreshing('all');
      setError(null);
      const [acc, dash] = await Promise.all([
        api.admin.masterAccounts.get(id),
        api.admin.masterAccounts.dashboard(id),
      ]);
      setAccount(acc);
      setData(dash);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load dashboard');
    } finally {
      setLoading(false);
      setRefreshing(null);
    }
  }

  async function refreshSession() {
    if (!id) return;
    setRefreshing('session');
    try {
      setError(null);
      const dash = await api.admin.masterAccounts.dashboard(id);
      setData(dash);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to refresh session');
    } finally {
      setRefreshing(null);
    }
  }

  async function refreshSection(section: BrokerDashboardSection) {
    if (!id) return;
    setRefreshing(section);
    try {
      const res = await api.admin.masterAccounts.section(id, section);
      setData((prev) => {
        if (!prev) return prev;
        const next: BrokerDashboardDto = { ...prev };
        if (section === 'profile') next.profile = (res.data as any) ?? prev.profile;
        else if (section === 'funds') next.funds = res.data as any;
        else if (section === 'holdings') next.holdings = res.data as any;
        else if (section === 'positions') next.positions = res.data as any;
        else if (section === 'orders') next.orders = res.data as any;
        else if (section === 'trades') next.trades = res.data as any;
        return next;
      });
    } catch (e: any) {
      setError(e?.message ?? 'Section refresh failed');
    } finally {
      setRefreshing(null);
    }
  }

  async function handleDisconnect() {
    if (!id) return;
    try {
      setDisconnecting(true);
      setDisconnectError(null);
      await api.admin.masterAccounts.disconnect(id);
      setConfirmDisconnect(false);
      await load(false);
    } catch (e: any) {
      setDisconnectError(e?.message ?? 'Failed to disconnect broker');
    } finally {
      setDisconnecting(false);
    }
  }

  // Sprint 6.2.13 — one-shot manual broker sync. Consumes POST /masters/:id/sync
  // and renders the summary exactly as returned by the backend. No polling.
  async function handleSyncBroker() {
    if (!id || syncing) return;
    try {
      setSyncing(true);
      setSyncError(null);
      setSyncResult(null);
      const result = await api.admin.masterAccounts.sync(id);
      setSyncResult(result);
    } catch (e: any) {
      setSyncError(e?.message ?? 'Broker sync failed');
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const health = data?.health ?? null;
  const isDisconnected =
    !health || health.connectionStatus === ConnectionStatus.DISCONNECTED;

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
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => load(false)}
            disabled={loading || refreshing !== null}
            data-testid="refresh-dashboard"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing === 'all' ? 'animate-spin' : ''}`} />
            {refreshing === 'all' ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setDisconnectError(null);
              setConfirmDisconnect(true);
            }}
            disabled={loading || isDisconnected}
            data-testid="disconnect-broker"
          >
            <PlugZap className="h-4 w-4" /> Disconnect Broker
          </Button>
        </div>
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

      {data && health && (
        <>
          {/* Connection Status */}
          <Card data-testid="section-connection-status">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1">
                  <CardTitle className="text-lg">Connection Status</CardTitle>
                  <CardDescription>Live session and broker connectivity</CardDescription>
                </div>
                <Button
                  variant="default"
                  onClick={handleSyncBroker}
                  disabled={syncing || isDisconnected}
                  data-testid="sync-broker-button"
                >
                  <RefreshCcw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
                  {syncing ? 'Syncing…' : 'Sync Broker'}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Live Connection</p>
                  <div className="flex items-center gap-2" data-testid="live-connection">
                    <StatusDot ok={health.connected} />
                    <span className="text-sm font-medium">
                      {health.connected ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Broker</p>
                  <p className="text-sm font-medium" data-testid="broker-name">
                    {BROKER_LABELS[health.broker] ?? health.broker}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
                  <ConnectionBadge status={health.connectionStatus} />
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Session</p>
                  <div className="flex items-center gap-2" data-testid="session-status">
                    {health.sessionActive ? (
                      <Badge variant="success" className="gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Active
                      </Badge>
                    ) : health.tokenExpired ? (
                      <Badge variant="warning" className="gap-1">
                        <ShieldAlert className="h-3 w-3" /> Token expired
                      </Badge>
                    ) : (
                      <Badge variant="muted" className="gap-1">
                        <XCircle className="h-3 w-3" /> Inactive
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Login Time</p>
                  <p className="text-sm font-mono" data-testid="login-time">{fmtDate(health.loginTime)}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Last Heartbeat</p>
                  <p className="text-sm font-mono" data-testid="last-heartbeat">{fmtDate(health.lastHeartbeat)}</p>
                </div>
              </div>

              {isDisconnected && (
                <div
                  className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm flex items-start gap-3 flex-wrap"
                  data-testid="reconnect-cta"
                >
                  <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-[220px]">
                    <p className="font-medium">This broker is disconnected.</p>
                    <p className="text-muted-foreground">
                      Reconnect from the Master Accounts list to resume live data, holdings, positions,
                      orders and trades.
                    </p>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/dashboard/master-accounts`} data-testid="go-reconnect">
                      Go to Master Accounts
                    </Link>
                  </Button>
                </div>
              )}

              {/* Sprint 6.2.13 — Manual Broker Sync result / error. */}
              {syncError && (
                <div
                  className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm flex items-start gap-3"
                  data-testid="sync-broker-error"
                >
                  <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-destructive">Broker Sync Failed</p>
                    <p className="text-muted-foreground" data-testid="sync-broker-error-message">
                      {syncError}
                    </p>
                  </div>
                </div>
              )}

              {syncResult && !syncError && (
                <div
                  className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm"
                  data-testid="sync-broker-result"
                >
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <p className="font-medium">Broker Sync Completed</p>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                    <div className="space-y-1">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">New Trades</p>
                      <p className="text-base font-semibold" data-testid="sync-new-trades">
                        {syncResult.newTrades}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Modified Trades</p>
                      <p className="text-base font-semibold" data-testid="sync-modified-trades">
                        {syncResult.modifiedTrades}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Closed Trades</p>
                      <p className="text-base font-semibold" data-testid="sync-closed-trades">
                        {syncResult.closedTrades}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Copy Jobs Created</p>
                      <p className="text-base font-semibold" data-testid="sync-copy-jobs">
                        {syncResult.copyJobsCreated}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Duration</p>
                      <p className="text-base font-semibold" data-testid="sync-duration">
                        {(syncResult.durationMs / 1000).toFixed(1)} sec
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Shared, normalized broker dashboard — identical to the Follower Portal. */}
          {!isDisconnected && (
            <BrokerDashboardPanel
              dashboard={data}
              loading={loading}
              refreshing={refreshing}
              onRefreshSection={refreshSection}
              onRefreshAll={() => load(false)}
              onRefreshSession={refreshSession}
            />
          )}
        </>
      )}

      <Dialog
        open={confirmDisconnect}
        onOpenChange={(v) => {
          if (!disconnecting) setConfirmDisconnect(v);
        }}
      >
        <DialogContent data-testid="disconnect-confirm-dialog">
          <DialogHeader>
            <DialogTitle>Disconnect broker?</DialogTitle>
            <DialogDescription>
              This will end the active broker session for{' '}
              <span className="font-medium text-foreground">{account?.nickname ?? 'this account'}</span>.
              Live data, holdings, positions, orders and trades will stop until you reconnect.
              The master account itself will be preserved.
            </DialogDescription>
          </DialogHeader>
          {disconnectError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{disconnectError}</span>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmDisconnect(false)}
              disabled={disconnecting}
              data-testid="disconnect-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDisconnect}
              disabled={disconnecting}
              data-testid="disconnect-confirm"
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
