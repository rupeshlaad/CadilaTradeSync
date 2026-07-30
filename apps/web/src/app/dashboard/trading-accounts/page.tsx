'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
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
import { Plus, Pencil, Trash2, Power } from 'lucide-react';
import { Broker, BROKER_LABELS, type TradingAccountDto, type CreateTradingAccountPayload } from '@cts/shared';

type FormState = CreateTradingAccountPayload & { enabled?: boolean };

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

export default function TradingAccountsPage() {
  const [rows, setRows] = useState<TradingAccountDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setLoading(true);
      setRows(await api.tradingAccounts.list());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
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
      if (form.password) payload.password = form.password;
      if (form.totpSecret) payload.totpSecret = form.totpSecret;
      if (form.staticIpPrimary) payload.staticIpPrimary = form.staticIpPrimary;
      if (form.staticIpSecondary) payload.staticIpSecondary = form.staticIpSecondary;
      if (editingId) await api.tradingAccounts.update(editingId, payload);
      else await api.tradingAccounts.create(payload);
      setOpen(false);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this trading account? This cannot be undone.')) return;
    await api.tradingAccounts.remove(id);
    await load();
  }

  async function handleToggle(row: TradingAccountDto) {
    if (row.enabled) await api.tradingAccounts.disable(row.id);
    else await api.tradingAccounts.enable(row.id);
    await load();
  }

  function connectBroker(row: TradingAccountDto) {
    const apiUrl =
      process.env.NEXT_PUBLIC_API_URL ??
      'http://localhost:4000';

    switch (row.broker) {
      case Broker.ZERODHA:
        window.location.href =
          `${apiUrl}/brokers/zerodha/login?tradingAccountId=${row.id}`;
        break;

      case Broker.FYERS:
        window.location.href =
          `${apiUrl}/brokers/fyers/login?tradingAccountId=${row.id}`;
        break;

      default:
        alert('Broker not supported yet.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Trading Accounts</h2>
          <p className="text-muted-foreground">Connect broker accounts. Credentials are stored encrypted.</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add account
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p className="text-sm">No trading accounts yet.</p>
              <Button className="mt-4" onClick={openCreate}>Add your first account</Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-3 pr-4">Nickname</th>
                    <th className="py-3 pr-4">Broker</th>
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
                      <td className="py-3 pr-4">
                        <Badge variant="secondary">{BROKER_LABELS[r.broker]}</Badge>
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs">{r.clientId}</td>
                      <td className="py-3 pr-4">
                        {r.connectionStatus === 'CONNECTED' ? (
                          <Badge variant="success">
                            CONNECTED
                          </Badge>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => connectBroker(r)}
                          >
                            Connect
                          </Button>
                        )}
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
            <DialogTitle>{editingId ? 'Edit trading account' : 'Add trading account'}</DialogTitle>
            <DialogDescription>Broker credentials are encrypted at rest. Leave secret fields blank on edit to keep existing values.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Broker</Label>
                <Select value={form.broker} onChange={(e) => setForm({ ...form, broker: e.target.value as Broker })}>
                  {Object.values(Broker).map((b) => (
                    <option key={b} value={b}>{BROKER_LABELS[b]}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Platform</Label>
                <Input value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} required />
              </div>
              <div className="space-y-1.5">
                <Label>Nickname</Label>
                <Input value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} required />
              </div>
              <div className="space-y-1.5">
                <Label>Client ID</Label>
                <Input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required />
              </div>
              <div className="space-y-1.5">
                <Label>API Key</Label>
                <Input type="password" value={form.apiKey ?? ''} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>API Secret</Label>
                <Input type="password" value={form.apiSecret ?? ''} onChange={(e) => setForm({ ...form, apiSecret: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Password</Label>
                <Input type="password" value={form.password ?? ''} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>TOTP Secret</Label>
                <Input type="password" value={form.totpSecret ?? ''} onChange={(e) => setForm({ ...form, totpSecret: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Static IP (primary)</Label>
                <Input value={form.staticIpPrimary ?? ''} onChange={(e) => setForm({ ...form, staticIpPrimary: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Static IP (secondary)</Label>
                <Input value={form.staticIpSecondary ?? ''} onChange={(e) => setForm({ ...form, staticIpSecondary: e.target.value })} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Create'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}