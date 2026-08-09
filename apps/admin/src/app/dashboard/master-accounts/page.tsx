'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, Pencil, Trash2, Power, LineChart } from 'lucide-react';
import Link from 'next/link';
import { Broker, BROKER_LABELS, type TradingAccountDto, type CreateTradingAccountPayload } from '@cts/shared';
import { BrokerAccountForm } from '@cts/ui';

type FormState = CreateTradingAccountPayload;

const emptyForm: FormState = {
  broker: Broker.ZERODHA,
  platform: 'REST',
  nickname: '',
  clientId: '',
  apiKey: '',
  apiSecret: '',
  password: '',
  totpSecret: '',
  staticIpPrimary: '',
  staticIpSecondary: '',
};

export default function MasterAccountsPage() {
  const [rows, setRows] = useState<TradingAccountDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Error carried over from the OAuth callback redirect
  // (/dashboard/master-accounts?error=...). Captured lazily at first
  // render so React 18 Strict Mode double-mount + load()'s setError(null)
  // cannot race and swallow it. Cleared only when the user dismisses it.
  const [oauthError, setOauthError] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('error');
  });
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  // Sprint 6.2.1 — ICICI Direct manual API-Session connect modal.
  const [sessionModal, setSessionModal] = useState<{
    open: boolean;
    row: TradingAccountDto | null;
  }>({ open: false, row: null });
  const [sessionToken, setSessionToken] = useState('');
  const [sessionSubmitting, setSessionSubmitting] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Fyers connect confirmation dialog (UI-only). Holds the pending Fyers OAuth
  // login URL; the redirect happens only after the user clicks Continue.
  const [fyersConfirmUrl, setFyersConfirmUrl] = useState<string | null>(null);

  function openIciciSession(row: TradingAccountDto) {
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
      await load();
    } catch (e: any) {
      setSessionError(e?.message ?? 'Connection failed');
    } finally {
      setSessionSubmitting(false);
    }
  }

  async function load() {
    try {
      setLoading(true);
      setError(null);
      setRows(await api.admin.masterAccounts.list());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Strip the ?error= query from the URL once, so a refresh doesn't
  // re-show the same OAuth error. Runs regardless of Strict Mode
  // double-invoke because it's idempotent (delete() on an absent key
  // is a no-op).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('error')) return;
    params.delete('error');
    const qs = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${qs ? `?${qs}` : ''}`,
    );
  }, []);

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
      if (form.staticIpSecondary) payload.staticIpSecondary = form.staticIpSecondary;
      if (editingId) await api.admin.masterAccounts.update(editingId, payload);
      else await api.admin.masterAccounts.create(payload);
      setOpen(false);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this master account? This cannot be undone.')) return;
    try {
      await api.admin.masterAccounts.remove(id);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleToggle(row: TradingAccountDto) {
    try {
      if (row.enabled) await api.admin.masterAccounts.disable(row.id);
      else await api.admin.masterAccounts.enable(row.id);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Master Accounts</h2>
          <p className="text-muted-foreground">Platform-owned broker accounts. Credentials are encrypted at rest.</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Master Account
        </Button>
      </div>

      {oauthError && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive flex items-start justify-between gap-3"
          data-testid="oauth-callback-error"
          role="alert"
        >
          <div className="flex-1 min-w-0">
            <p className="font-medium">Broker reconnect failed</p>
            <p className="break-words">{oauthError}</p>
          </div>
          <button
            type="button"
            className="text-xs underline hover:no-underline shrink-0"
            onClick={() => setOauthError(null)}
            data-testid="oauth-callback-error-dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && <p className="text-sm text-destructive" data-testid="master-accounts-error">{error}</p>}

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p className="text-sm">No master accounts yet.</p>
              <Button className="mt-4" onClick={openCreate}>Create the first master account</Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-3 pr-4">Nickname</th>
                    <th className="py-3 pr-4">Broker</th>
                    <th className="py-3 pr-4">Platform</th>
                    <th className="py-3 pr-4">Client ID</th>
                    <th className="py-3 pr-4">Status</th>
                    <th className="py-3 pr-4">Credentials</th>
                    <th className="py-3 pr-4">Enabled</th>
                    <th className="py-3 pr-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-none">
                      <td className="py-3 pr-4 font-medium">{r.nickname}</td>
                      <td className="py-3 pr-4"><Badge variant="secondary">{BROKER_LABELS[r.broker]}</Badge></td>
                      <td className="py-3 pr-4 text-xs text-muted-foreground">{r.platform}</td>
                      <td className="py-3 pr-4 font-mono text-xs">{r.clientId}</td>
                      <td className="py-3 pr-4">
                        <Button
                          size="sm"
                          onClick={() => {
                            if (r.broker === 'ICICI_DIRECT') {
                              // Sprint 6.2.1 — no OAuth redirect for ICICI.
                              openIciciSession(r);
                              return;
                            }
                            const api =
                              process.env.NEXT_PUBLIC_API_URL ??
                              'http://localhost:4000';

                            // Sprint 6.1.1 — preserve origin so the
                            // callback returns to this master-accounts
                            // page (not a broker JSON page).
                            const returnTo = encodeURIComponent(
                              '/dashboard/master-accounts',
                            );
                            const brokerPath =
                              r.broker === 'FYERS'
                                ? 'fyers'
                                : r.broker === 'SHOONYA'
                                ? 'shoonya'
                                : 'zerodha';
                            const loginUrl =
                              `${api}/brokers/${brokerPath}/login?tradingAccountId=${r.id}&returnTo=${returnTo}`;
                            if (r.broker === 'FYERS') {
                              // UI-only: confirm before redirecting so the user
                              // can avoid a reused Fyers browser session
                              // connecting the wrong account.
                              setFyersConfirmUrl(loginUrl);
                              return;
                            }
                            window.location.href = loginUrl;
                          }}
                          data-testid={`master-accounts-connect-btn-${r.id}`}
                        >
                          {r.connectionStatus === 'CONNECTED'
                            ? 'Reconnect'
                            : r.connectionStatus === 'ERROR'
                            ? 'Reconnect'
                            : 'Connect'}
                        </Button>
                      </td>
                      <td className="py-3 pr-4 text-xs text-muted-foreground">
                        {[r.hasApiKey && 'API Key', r.hasApiSecret && 'Secret', r.hasPassword && 'Password', r.hasTotpSecret && 'TOTP']
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </td>
                      <td className="py-3 pr-4">
                        <Switch checked={r.enabled} onCheckedChange={() => handleToggle(r)} />
                      </td>
                      <td className="py-3 pr-4 text-right space-x-1">
                        <Button size="sm" variant="outline" asChild data-testid={`view-dashboard-${r.id}`}>
                          <Link href={`/dashboard/master-accounts/${r.id}/dashboard`}>
                            <LineChart className="h-4 w-4" /> View Dashboard
                          </Link>
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => openEdit(r)} aria-label="Edit">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => handleToggle(r)} aria-label="Toggle">
                          <Power className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => handleDelete(r.id)} aria-label="Delete">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit master account' : 'Add master account'}</DialogTitle>
            <DialogDescription>
              Credentials are encrypted before storage. Leave secret fields blank on edit to keep existing values.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <BrokerAccountForm
              value={form}
              onChange={(patch) => setForm({ ...form, ...patch })}
              editing={!!editingId}
              testIdPrefix="master-accounts-form"
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Create'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={sessionModal.open}
        onOpenChange={(v) => !v && setSessionModal({ open: false, row: null })}
      >
        <DialogContent data-testid="icici-session-modal">
          <DialogHeader>
            <DialogTitle>Connect ICICI Direct</DialogTitle>
            <DialogDescription>
              Generate a fresh API Session from the ICICI Breeze Portal and paste it below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="icici-api-session-admin">
              API Session (from ICICI Breeze Portal)
            </Label>
            <Textarea
              id="icici-api-session-admin"
              rows={3}
              placeholder="Paste your API Session here"
              value={sessionToken}
              onChange={(e) => setSessionToken(e.target.value)}
              data-testid="icici-session-input"
            />
            <p className="text-xs text-muted-foreground">
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
              <p className="text-sm text-destructive" data-testid="icici-session-error">
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

      <Dialog
        open={fyersConfirmUrl !== null}
        onOpenChange={(o) => {
          if (!o) setFyersConfirmUrl(null);
        }}
      >
        <DialogContent data-testid="fyers-connect-confirm-modal">
          <DialogHeader>
            <DialogTitle>Connect FYERS Account</DialogTitle>
            <DialogDescription className="space-y-2">
              <span className="block">
                If another FYERS account is already logged in in this browser,
                FYERS may reuse that session.
              </span>
              <span className="block">For connecting a different FYERS account:</span>
              <span className="block">
                • Log out from{' '}
                <a
                  href="https://trade.fyers.in/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  data-testid="fyers-connect-help-link"
                >
                  https://trade.fyers.in
                </a>{' '}
                first, OR
              </span>
              <span className="block">
                • Open the connection in an Incognito/Private window.
              </span>
              <span className="block">Then continue with authentication.</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <a
              href="https://trade.fyers.in/"
              target="_blank"
              rel="noopener noreferrer"
              className="mr-auto text-sm underline self-center"
              data-testid="fyers-connect-open-login-link"
            >
              Open FYERS Login
            </a>
            <Button
              type="button"
              variant="outline"
              onClick={() => setFyersConfirmUrl(null)}
              data-testid="fyers-connect-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (fyersConfirmUrl) window.location.href = fyersConfirmUrl;
              }}
              data-testid="fyers-connect-continue"
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}