'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import {
  BROKER_LABELS,
  BROKER_SESSION_HEALTH_LABELS,
  type FollowerDto,
  type FollowerOverviewDto,
} from '@cts/shared';

function fmt(iso: string | null | undefined): string {
  if (!iso) return 'Not provided';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Not provided' : d.toLocaleString();
}

function Field({ label, value, testid }: { label: string; value: React.ReactNode; testid?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm" data-testid={testid}>{value}</div>
    </div>
  );
}

type FollowerUserGroup = {
  userId: string;
  name: string | null;
  email: string | null;
  links: FollowerDto[];
};

export default function FollowerManagementPage() {
  const [rows, setRows] = useState<FollowerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [overview, setOverview] = useState<Record<string, FollowerOverviewDto>>({});
  const [overviewLoading, setOverviewLoading] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setRows(await api.admin.followers.list());
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load followers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Group follower links by follower user.
  const groups: FollowerUserGroup[] = [];
  const byUser = new Map<string, FollowerUserGroup>();
  for (const r of rows) {
    let g = byUser.get(r.followerUserId);
    if (!g) {
      g = {
        userId: r.followerUserId,
        name: r.followerUser?.name ?? null,
        email: r.followerUser?.email ?? null,
        links: [],
      };
      byUser.set(r.followerUserId, g);
      groups.push(g);
    }
    g.links.push(r);
  }

  async function toggle(userId: string) {
    if (expanded === userId) {
      setExpanded(null);
      return;
    }
    setExpanded(userId);
    if (!overview[userId]) {
      try {
        setOverviewLoading(userId);
        const o = await api.admin.followers.overview(userId);
        setOverview((prev) => ({ ...prev, [userId]: o }));
      } catch (e: any) {
        setError(e?.message ?? 'Failed to load follower overview');
      } finally {
        setOverviewLoading(null);
      }
    }
  }

  async function setEnabled(userId: string, followerId: string, enabled: boolean) {
    try {
      setBusy(followerId);
      if (enabled) await api.admin.followers.enable(followerId);
      else await api.admin.followers.disable(followerId);
      const o = await api.admin.followers.overview(userId);
      setOverview((prev) => ({ ...prev, [userId]: o }));
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Action failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">Follower Management</h2>
          <p className="text-muted-foreground">
            Monitor every follower&apos;s profile, broker connections, subscriptions
            and trading activity. Credentials are never exposed.
          </p>
        </div>
        <Button variant="outline" onClick={load} data-testid="followers-refresh-btn">
          <RefreshCw className="h-4 w-4 mr-2" /> Refresh
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive" data-testid="followers-error">{error}</p>
      )}

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : groups.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              No followers yet.
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => {
                const isOpen = expanded === g.userId;
                const ov = overview[g.userId];
                return (
                  <div
                    key={g.userId}
                    className="rounded-lg border"
                    data-testid={`follower-row-${g.userId}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(g.userId)}
                      className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-accent/50"
                      data-testid={`follower-toggle-${g.userId}`}
                    >
                      <div className="flex items-center gap-3">
                        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        <div>
                          <div className="font-medium">{g.name ?? g.email ?? 'Unknown'}</div>
                          <div className="text-xs text-muted-foreground">{g.email}</div>
                        </div>
                      </div>
                      <Badge variant="secondary">
                        {g.links.length} strateg{g.links.length === 1 ? 'y' : 'ies'}
                      </Badge>
                    </button>

                    {isOpen && (
                      <div className="border-t p-4 space-y-6" data-testid={`follower-overview-${g.userId}`}>
                        {overviewLoading === g.userId && !ov ? (
                          <p className="text-sm text-muted-foreground">Loading overview…</p>
                        ) : ov ? (
                          <>
                            {/* Profile */}
                            <section>
                              <h4 className="text-sm font-semibold mb-2">Follower Profile</h4>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <Field label="Full Name" value={ov.profile.fullName ?? 'Not provided'} />
                                <Field label="Email" value={ov.profile.email} />
                                <Field label="Mobile" value={ov.profile.mobile ?? 'Not provided'} />
                                <Field label="User ID" value={<span className="font-mono text-xs">{ov.profile.userId}</span>} />
                                <Field label="Registration Date" value={fmt(ov.profile.registrationDate)} />
                                <Field
                                  label="Account Status"
                                  value={
                                    <Badge variant={ov.profile.accountStatus === 'ACTIVE' ? 'success' : 'muted'}>
                                      {ov.profile.accountStatus}
                                    </Badge>
                                  }
                                />
                                <Field label="Last Login" value={ov.profile.lastLogin ? fmt(ov.profile.lastLogin) : 'Not provided'} />
                                <Field label="Last Activity" value={ov.profile.lastActivity ? fmt(ov.profile.lastActivity) : 'Not provided'} />
                                <Field label="Country" value={ov.profile.country ?? 'Not provided'} />
                                <Field label="Subscription Plan" value={ov.profile.subscriptionPlan ?? 'Not provided'} />
                              </div>
                            </section>

                            {/* Broker Summary */}
                            <section>
                              <h4 className="text-sm font-semibold mb-2">Broker Accounts</h4>
                              {ov.brokerAccounts.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No broker accounts connected.</p>
                              ) : (
                                <div className="space-y-2">
                                  {ov.brokerAccounts.map((b) => (
                                    <div
                                      key={b.id}
                                      className="rounded-md border p-3 grid grid-cols-2 md:grid-cols-4 gap-3"
                                      data-testid={`follower-broker-${b.id}`}
                                    >
                                      <Field label="Broker" value={b.brokerLabel} />
                                      <Field label="Client ID" value={<span className="font-mono text-xs">{b.clientId}</span>} />
                                      <Field label="Account Holder" value={b.accountHolder ?? 'Not provided'} />
                                      <Field
                                        label="Connection"
                                        value={
                                          <Badge variant={b.connectionStatus === 'CONNECTED' ? 'success' : b.connectionStatus === 'EXPIRED' ? 'warning' : 'muted'}>
                                            {b.connectionStatus}
                                          </Badge>
                                        }
                                      />
                                      <Field label="Session Health" value={BROKER_SESSION_HEALTH_LABELS[b.sessionHealthState]} />
                                      <Field label="Token Status" value={b.tokenStatus} />
                                      <Field label="Login Time" value={fmt(b.loginTime)} />
                                      <Field label="Last Sync" value={fmt(b.lastSync)} />
                                      <Field label="Connected Since" value={fmt(b.connectedSince)} />
                                    </div>
                                  ))}
                                </div>
                              )}
                            </section>

                            {/* Subscriptions + Controls */}
                            <section>
                              <h4 className="text-sm font-semibold mb-2">Subscriptions &amp; Copy Trading</h4>
                              <div className="space-y-2">
                                {ov.subscriptions.map((s) => (
                                  <div
                                    key={s.followerId}
                                    className="rounded-md border p-3 flex flex-wrap items-center justify-between gap-3"
                                    data-testid={`follower-subscription-${s.followerId}`}
                                  >
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-1">
                                      <Field label="Strategy" value={s.strategyName ?? s.strategyId} />
                                      <Field label="Strategy Status" value={s.strategyStatus ?? 'Not provided'} />
                                      <Field label="Subscription" value={s.subscriptionStatus ?? 'Not provided'} />
                                      <Field label="Subscribed" value={fmt(s.subscriptionDate)} />
                                      <Field
                                        label="Copy Trading"
                                        value={
                                          <Badge variant={s.copyTradingEnabled ? 'success' : 'muted'}>
                                            {s.copyTradingEnabled ? 'ENABLED' : 'PAUSED'}
                                          </Badge>
                                        }
                                      />
                                      <Field label="Multiplier" value={`${s.multiplier}x`} />
                                      <Field label="Max Loss" value={s.maximumLoss ?? 'Not provided'} />
                                      <Field label="Max Daily Loss" value={s.maximumDailyLoss ?? 'Not provided'} />
                                    </div>
                                    <Button
                                      size="sm"
                                      variant={s.copyTradingEnabled ? 'destructive' : 'default'}
                                      disabled={busy === s.followerId}
                                      onClick={() => setEnabled(g.userId, s.followerId, !s.copyTradingEnabled)}
                                      data-testid={`follower-toggle-copy-${s.followerId}`}
                                    >
                                      {s.copyTradingEnabled ? 'Pause Copy Trading' : 'Resume Copy Trading'}
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            </section>

                            {/* Trading Summary */}
                            <section>
                              <h4 className="text-sm font-semibold mb-2">Trading Summary</h4>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <Field label="Total Orders" value={ov.trading.totalOrders} testid={`follower-total-orders-${g.userId}`} />
                                <Field label="Successful" value={ov.trading.successfulOrders} />
                                <Field label="Failed" value={ov.trading.failedOrders} />
                                <Field label="Skipped" value={ov.trading.skippedOrders} />
                                <Field label="Last Trade" value={ov.trading.lastTradeAt ? fmt(ov.trading.lastTradeAt) : 'No trades yet'} />
                                <Field label="Open Positions" value={ov.trading.openPositions ?? 'Not available yet'} />
                                <Field label="Current P&L" value={ov.trading.currentPnl ?? 'Not available yet'} />
                                <Field label="Lifetime P&L" value={ov.trading.lifetimePnl ?? 'Not available yet'} />
                              </div>
                            </section>

                            {/* Navigation to existing detail surfaces */}
                            <section className="flex flex-wrap gap-2">
                              <Button size="sm" variant="outline" asChild>
                                <Link href="/dashboard/trade-monitor">View Execution History</Link>
                              </Button>
                            </section>
                          </>
                        ) : (
                          <p className="text-sm text-destructive">Overview unavailable.</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
