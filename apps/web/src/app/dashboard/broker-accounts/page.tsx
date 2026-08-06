'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import {
  BrokerAccountCard,
  BrokerAccountForm,
  BrokerDashboardPanel,
  type BrokerAccountCardData,
} from '@cts/ui';
import type {
  BrokerConnectionState,
  BrokerDashboardDto,
  BrokerDashboardSection,
} from '@cts/shared';
import {
  BROKER_LABELS,
  Broker,
  type TradingAccountDto,
  type CreateTradingAccountPayload,
} from '@cts/shared';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, RefreshCw } from 'lucide-react';

/**
 * Sprint 6.1 — Follower "Broker Accounts" page.
 *
 * Reuses the same broker OAuth flow the Master Portal uses
 * (/brokers/{zerodha,fyers,shoonya}/login?tradingAccountId=…) with
 * the Sprint 6.1 callback router redirecting followers back to this
 * page on completion. No duplicated OAuth logic in the frontend.
 */

type FormState = CreateTradingAccountPayload & {
  vendorCode?: string;
  enabled?: boolean;
};

const emptyForm: FormState = {
  broker: Broker.ZERODHA,
  platform: 'REST',
  nickname: '',
  clientId: '',
  apiKey: '',
  apiSecret: '',
  vendorCode: '',
  password: '',
  totpSecret: '',
  staticIpPrimary: '',
  staticIpSecondary: '',
};

function mapConnectionState(v: string | null | undefined): BrokerConnectionState {
  switch ((v ?? '').toUpperCase()) {
    case 'CONNECTED':
      return 'CONNECTED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'ERROR':
      return 'ERROR';
    default:
      return 'DISCONNECTED';
  }
}

function toCardData(
  row: TradingAccountDto,
  health: FollowerHealthById | undefined,
  dash: BrokerDashboardDto | undefined,
): BrokerAccountCardData {
  // Sprint 6.1.2 — connection state is driven by the persisted backend
  // session-health, never by frontend-only state. Falls back to the row's
  // stored status only until the health probe resolves.
  const connectionState = mapConnectionState(
    health?.connectionStatus ?? (row.connectionStatus as any),
  );
  const loginTime = health?.loginTime ?? null;
  const accountHolder =
    dash?.health.accountHolder ?? health?.accountHolder ?? null;
  return {
    id: row.id,
    broker: row.broker,
    brokerLabel: BROKER_LABELS[row.broker] ?? row.broker,
    nickname: row.nickname,
    clientId: row.clientId,
    connectionState,
    enabled: row.enabled,
    lastHeartbeat:
      dash?.health.lastHeartbeat ?? row.lastHeartbeat ?? health?.lastHeartbeat ?? null,
    lastLogin: loginTime,
    createdAt: row.createdAt ?? null,
    hasApiKey: row.hasApiKey,
    hasApiSecret: row.hasApiSecret,
    hasPassword: row.hasPassword,
    hasTotpSecret: row.hasTotpSecret,
    sessionHealthState: health?.sessionHealthState ?? null,
    tokenStatus: health?.tokenStatus ?? null,
    accountHolder,
    connectionTime: dash?.health.loginTime ?? loginTime,
    capabilities: dash?.capabilities ?? null,
    liveProfile: dash?.profile ?? null,
    sessionHealth: health
      ? {
          healthy:
            health.sessionActive === true &&
            (health.tokenExpired === null || health.tokenExpired === false),
          sessionActive: health.sessionActive,
          tokenExpired: health.tokenExpired,
          lastCheckedAt: new Date().toISOString(),
        }
      : null,
    details: {
      exchanges: dash?.profile.exchanges ?? null,
      products: dash?.profile.products ?? null,
      funds: dash?.funds ?? null,
      marginAvailable: dash ? dash.errors.margins === null && dash.funds !== null : null,
    },
  };
}

type RefreshTarget = BrokerDashboardSection | 'all' | 'session' | null;

type FollowerHealthById = Awaited<
  ReturnType<typeof api.tradingAccounts.sessionHealth>
>;

export default function BrokerAccountsPage() {
  const searchParams = useSearchParams();
  const oauthConnected = searchParams?.get('connected');
  const oauthError = searchParams?.get('error');

  const [rows, setRows] = useState<TradingAccountDto[]>([]);
  const [healthByAccount, setHealthByAccount] = useState<
    Record<string, FollowerHealthById>
  >({});
  const [infoByAccount, setInfoByAccount] = useState<
    Record<string, BrokerDashboardDto>
  >({});
  const [refreshing, setRefreshing] = useState<Record<string, RefreshTarget>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Sprint 6.2.1 — ICICI Direct manual API-Session connect modal.
  const [sessionModal, setSessionModal] = useState<{
    open: boolean;
    row: BrokerAccountCardData | null;
  }>({ open: false, row: null });
  const [sessionToken, setSessionToken] = useState('');
  const [sessionSubmitting, setSessionSubmitting] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const list = await api.tradingAccounts.list();
      setRows(list);

      // Sprint 6.1.2 — connection state is the persisted backend session
      // health, so both the Overview and this page read one source of truth.
      // For connected accounts we additionally verify against the broker
      // (profile / entitlements / funds) so the card can confirm the link.
      const healthMap: Record<string, FollowerHealthById> = {};
      const infoMap: Record<string, BrokerDashboardDto> = {};
      await Promise.all(
        list.map(async (row) => {
          try {
            const h = await api.tradingAccounts.sessionHealth(row.id);
            healthMap[row.id] = h;
            if (h.connectionStatus === 'CONNECTED') {
              try {
                // Sprint 6.1.5 — auto-verify against the broker SDK on open.
                infoMap[row.id] = await api.tradingAccounts.dashboard(row.id);
              } catch {
                /* live verify is best-effort; card still shows persisted state */
              }
            }
          } catch {
            /* ignore per-account errors */
          }
        }),
      );
      setHealthByAccount(healthMap);
      setInfoByAccount(infoMap);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load broker accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (oauthConnected === '1') {
      setBanner({
        kind: 'success',
        message: 'Broker connected successfully.',
      });
    } else if (oauthError) {
      setBanner({ kind: 'error', message: oauthError });
    }
  }, [oauthConnected, oauthError]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function openEdit(row: TradingAccountDto) {
    setEditingId(row.id);
    setForm({
      broker: row.broker,
      platform: row.platform,
      nickname: row.nickname,
      clientId: row.clientId,
      apiKey: '',
      apiSecret: '',
      vendorCode: '',
      password: '',
      totpSecret: '',
      staticIpPrimary: row.staticIpPrimary ?? '',
      staticIpSecondary: row.staticIpSecondary ?? '',
    });
    setOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload: CreateTradingAccountPayload = {
        broker: form.broker,
        platform: form.platform,
        nickname: form.nickname,
        clientId: form.clientId,
      };
      if (form.apiKey) payload.apiKey = form.apiKey;
      if (form.apiSecret) payload.apiSecret = form.apiSecret;
      if (form.vendorCode) payload.vendorCode = form.vendorCode;
      if (form.password) payload.password = form.password;
      if (form.totpSecret) payload.totpSecret = form.totpSecret;
      if (form.staticIpPrimary) payload.staticIpPrimary = form.staticIpPrimary;
      if (form.staticIpSecondary)
        payload.staticIpSecondary = form.staticIpSecondary;

      if (editingId) await api.tradingAccounts.update(editingId, payload);
      else await api.tradingAccounts.create(payload);
      setOpen(false);
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save broker account');
    } finally {
      setSaving(false);
    }
  }

  const apiBaseUrl = useMemo(
    () => process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
    [],
  );

  function connectBroker(row: BrokerAccountCardData) {
    // Sprint 6.1.1 — preserve origin. After OAuth completes the API
    // callback redirects back to this exact page.
    const returnTo = encodeURIComponent('/dashboard/broker-accounts');
    const q = `tradingAccountId=${row.id}&returnTo=${returnTo}`;
    switch (row.broker) {
      case Broker.ZERODHA:
        window.location.href = `${apiBaseUrl}/brokers/zerodha/login?${q}`;
        break;
      case Broker.FYERS:
        window.location.href = `${apiBaseUrl}/brokers/fyers/login?${q}`;
        break;
      case Broker.SHOONYA:
        window.location.href = `${apiBaseUrl}/brokers/shoonya/login?${q}`;
        break;
      case Broker.ICICI_DIRECT:
        // Sprint 6.2.1 — no OAuth redirect; paste a Breeze API Session instead.
        openIciciSession(row);
        break;
      default:
        setBanner({ kind: 'error', message: 'Broker not supported yet.' });
    }
  }

  function openIciciSession(row: BrokerAccountCardData) {
    setSessionModal({ open: true, row });
    setSessionToken('');
    setSessionError(null);
  }

  async function submitIciciSession() {
    if (!sessionModal.row) return;
    setSessionSubmitting(true);
    setSessionError(null);
    try {
      await api.icici.connectSession(sessionModal.row.id, sessionToken.trim());
      setSessionModal({ open: false, row: null });
      setSessionToken('');
      setBanner({ kind: 'success', message: 'ICICI Direct connected.' });
      await load();
    } catch (e: any) {
      setSessionError(e?.message ?? 'Connection failed');
    } finally {
      setSessionSubmitting(false);
    }
  }

  async function refreshHealth(row: BrokerAccountCardData) {
    try {
      const h = await api.tradingAccounts.sessionHealth(row.id);
      setHealthByAccount((prev) => ({ ...prev, [row.id]: h }));
      setBanner({ kind: 'success', message: 'Session health refreshed.' });
    } catch (e: any) {
      setBanner({
        kind: 'error',
        message: e?.message ?? 'Health probe failed',
      });
    }
  }

  function setBusy(id: string, target: RefreshTarget) {
    setRefreshing((prev) => ({ ...prev, [id]: target }));
  }

  async function refreshSession(row: BrokerAccountCardData) {
    // Sprint 6.2.1 — ICICI has no OAuth; "Refresh Session" re-opens the paste modal.
    if (row.broker === Broker.ICICI_DIRECT) {
      openIciciSession(row);
      return;
    }
    // Sprint 6.1.5 — re-verify session health + full SDK dashboard.
    setBusy(row.id, 'session');
    try {
      const [h, dash] = await Promise.all([
        api.tradingAccounts.sessionHealth(row.id),
        api.tradingAccounts.dashboard(row.id),
      ]);
      setHealthByAccount((prev) => ({ ...prev, [row.id]: h }));
      setInfoByAccount((prev) => ({ ...prev, [row.id]: dash }));
      setBanner({ kind: 'success', message: 'Broker session verified.' });
    } catch (e: any) {
      setBanner({ kind: 'error', message: e?.message ?? 'Session verification failed' });
    } finally {
      setBusy(row.id, null);
    }
  }

  async function refreshAll(row: BrokerAccountCardData) {
    setBusy(row.id, 'all');
    try {
      const [h, dash] = await Promise.all([
        api.tradingAccounts.sessionHealth(row.id),
        api.tradingAccounts.dashboard(row.id),
      ]);
      setHealthByAccount((prev) => ({ ...prev, [row.id]: h }));
      setInfoByAccount((prev) => ({ ...prev, [row.id]: dash }));
    } catch (e: any) {
      setBanner({ kind: 'error', message: e?.message ?? 'Refresh failed' });
    } finally {
      setBusy(row.id, null);
    }
  }

  async function refreshSection(row: BrokerAccountCardData, section: BrokerDashboardSection) {
    // Sprint 6.1.5 — granular live SDK refresh; merge into cached dashboard.
    setBusy(row.id, section);
    try {
      const res = await api.tradingAccounts.section(row.id, section);
      setInfoByAccount((prev) => {
        const current = prev[row.id];
        if (!current) return prev;
        const next: BrokerDashboardDto = { ...current };
        if (section === 'profile') next.profile = (res.data as any) ?? current.profile;
        else if (section === 'funds') next.funds = res.data as any;
        else if (section === 'holdings') next.holdings = res.data as any;
        else if (section === 'positions') next.positions = res.data as any;
        else if (section === 'orders') next.orders = res.data as any;
        else if (section === 'trades') next.trades = res.data as any;
        return { ...prev, [row.id]: next };
      });
      if (res.error) setBanner({ kind: 'error', message: res.error });
    } catch (e: any) {
      setBanner({ kind: 'error', message: e?.message ?? 'Section refresh failed' });
    } finally {
      setBusy(row.id, null);
    }
  }

  async function refreshProfile(row: BrokerAccountCardData) {
    await refreshSection(row, 'profile');
    setBanner({ kind: 'success', message: 'Broker profile refreshed.' });
  }

  async function disconnectBroker(row: BrokerAccountCardData) {
    if (!confirm(`Disconnect ${row.brokerLabel} for ${row.nickname}?`)) return;
    try {
      await api.tradingAccounts.disconnect(row.id);
      // Sprint 6.1.4 — no supported broker SDK exposes token revoke/logout,
      // so we are explicit that only the CTS session was invalidated.
      setBanner({
        kind: 'success',
        message:
          'Disconnected from CTS. Broker authorization remains active.',
      });
      await load();
    } catch (e: any) {
      setBanner({
        kind: 'error',
        message: e?.message ?? 'Disconnect failed',
      });
    }
  }

  async function toggleEnabled(row: BrokerAccountCardData) {
    try {
      if (row.enabled) await api.tradingAccounts.disable(row.id);
      else await api.tradingAccounts.enable(row.id);
      await load();
    } catch (e: any) {
      setBanner({
        kind: 'error',
        message: e?.message ?? 'Toggle failed',
      });
    }
  }

  async function removeAccount(row: BrokerAccountCardData) {
    if (!confirm(`Delete ${row.nickname}? This cannot be undone.`)) return;
    try {
      await api.tradingAccounts.remove(row.id);
      await load();
    } catch (e: any) {
      setBanner({
        kind: 'error',
        message: e?.message ?? 'Delete failed',
      });
    }
  }

  function toggleDetails(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const cards = rows.map((r) =>
    toCardData(r, healthByAccount[r.id], infoByAccount[r.id]),
  );
  const connectedCount = cards.filter((c) => c.connectionState === 'CONNECTED').length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">Broker Accounts</h2>
          <p className="text-muted-foreground">
            Manage the broker accounts that power your copy-trading
            subscriptions. Credentials are stored encrypted; the OAuth flow
            is shared with the Master Portal.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={load}
            data-testid="broker-accounts-refresh-btn"
          >
            <RefreshCw className="h-4 w-4 mr-2" /> Refresh
          </Button>
          <Button onClick={openCreate} data-testid="broker-accounts-add-btn">
            <Plus className="h-4 w-4 mr-1" /> Add broker
          </Button>
        </div>
      </div>

      {banner && (
        <div
          className={`rounded-lg border p-3 text-sm flex items-start justify-between gap-3 ${
            banner.kind === 'success'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-destructive/40 bg-destructive/10 text-destructive'
          }`}
          data-testid={`broker-accounts-banner-${banner.kind}`}
        >
          <span>{banner.message}</span>
          <button
            className="text-xs font-medium hover:underline"
            onClick={() => setBanner(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div
          className="text-sm text-destructive"
          data-testid="broker-accounts-error"
        >
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connected Brokers</CardTitle>
          <CardDescription>
            {rows.length === 0
              ? 'No broker accounts yet.'
              : `${connectedCount} of ${rows.length} brokers connected`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <p className="text-sm">
                Add your first broker to start copy trading.
              </p>
              <Button className="mt-4" onClick={openCreate}>
                <Plus className="h-4 w-4 mr-1" /> Add broker
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6">
              {cards.map((card) => {
                const dash = infoByAccount[card.id];
                const isConnected = card.connectionState === 'CONNECTED';
                return (
                  <div key={card.id} className="space-y-3">
                    <BrokerAccountCard
                      account={card}
                      onConnect={connectBroker}
                      onReconnect={connectBroker}
                      onDisconnect={disconnectBroker}
                      onEdit={(c) => {
                        const original = rows.find((r) => r.id === c.id);
                        if (original) openEdit(original);
                      }}
                      onRemove={removeAccount}
                      onToggleEnabled={toggleEnabled}
                      onRefreshHealth={refreshHealth}
                      onRefreshSession={refreshSession}
                      onRefreshProfile={refreshProfile}
                      showDetails={expanded.has(card.id)}
                      onToggleDetails={() => toggleDetails(card.id)}
                    />
                    {isConnected && (
                      <BrokerDashboardPanel
                        dashboard={dash ?? null}
                        loading={!dash}
                        refreshing={refreshing[card.id] ?? null}
                        onRefreshSection={(section) => refreshSection(card, section)}
                        onRefreshAll={() => refreshAll(card)}
                        onRefreshSession={() => refreshSession(card)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingId ? 'Edit broker account' : 'Add broker account'}
            </DialogTitle>
            <DialogDescription>
              Broker credentials are encrypted at rest. Leave secret fields
              blank on edit to keep existing values.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={handleSubmit}
            className="space-y-4"
            data-testid="broker-accounts-form"
          >
            <BrokerAccountForm
              value={form}
              onChange={(patch) => setForm({ ...form, ...patch })}
              editing={!!editingId}
              testIdPrefix="broker-accounts-form"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving}
                data-testid="broker-accounts-form-submit"
              >
                {saving
                  ? 'Saving…'
                  : editingId
                  ? 'Save changes'
                  : 'Create broker'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={sessionModal.open}
        onOpenChange={(v) =>
          !v && setSessionModal({ open: false, row: null })
        }
      >
        <DialogContent data-testid="icici-session-modal">
          <DialogHeader>
            <DialogTitle>Connect ICICI Direct</DialogTitle>
            <DialogDescription>
              Generate a fresh API Session from the ICICI Breeze Portal and
              paste it below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="icici-api-session">
              API Session (from ICICI Breeze Portal)
            </Label>
            <Textarea
              id="icici-api-session"
              rows={3}
              placeholder="Paste your API Session here"
              value={sessionToken}
              onChange={(e) => setSessionToken(e.target.value)}
              data-testid="icici-session-input"
            />
            <p className="text-xs text-gray-500">
              Generate a new API Session from the{' '}
              <a
                href="https://api.icicidirect.com/apiuser/login"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                ICICI Breeze portal
              </a>{' '}
              after logging in. This session expires daily.
            </p>
            {sessionError && (
              <p
                className="text-sm text-red-600"
                data-testid="icici-session-error"
              >
                {sessionError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSessionModal({ open: false, row: null })}
              data-testid="icici-session-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitIciciSession}
              disabled={sessionSubmitting || !sessionToken.trim()}
              data-testid="icici-session-connect"
            >
              {sessionSubmitting ? 'Connecting…' : 'Connect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
