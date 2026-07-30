'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import {
  BROKER_LABELS,
  StrategyStatus,
  Visibility,
  type StrategyDto,
  type TradingAccountDto,
  type CreateStrategyPayload,
} from '@cts/shared';

const emptyForm: CreateStrategyPayload = {
  tradingAccountId: '',
  strategyName: '',
  description: '',
  visibility: Visibility.PRIVATE,
  masterAccount: false,
  baseQuantity: 1,
  maxFollowers: 0,
  status: StrategyStatus.DRAFT,
  enabled: true,
};

export default function StrategiesPage() {
  const [rows, setRows] = useState<StrategyDto[]>([]);
  const [accounts, setAccounts] = useState<TradingAccountDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CreateStrategyPayload>(emptyForm);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setLoading(true);
      const [s, a] = await Promise.all([api.strategies.list(), api.tradingAccounts.list()]);
      setRows(s);
      setAccounts(a);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setEditingId(null);
    setForm({ ...emptyForm, tradingAccountId: accounts[0]?.id ?? '' });
    setOpen(true);
  }

  function openEdit(row: StrategyDto) {
    setEditingId(row.id);
    setForm({
      tradingAccountId: row.tradingAccountId,
      strategyName: row.strategyName,
      description: row.description ?? '',
      visibility: row.visibility,
      masterAccount: row.masterAccount,
      baseQuantity: row.baseQuantity,
      maxFollowers: row.maxFollowers,
      status: row.status,
      enabled: row.enabled,
    });
    setOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        const { tradingAccountId, ...rest } = form;
        await api.strategies.update(editingId, rest);
      } else {
        await api.strategies.create(form);
      }
      setOpen(false);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this strategy? Followers will be detached.')) return;
    await api.strategies.remove(id);
    await load();
  }

  const statusVariant = (s: StrategyStatus): 'success' | 'warning' | 'muted' | 'secondary' => {
    if (s === 'ACTIVE') return 'success';
    if (s === 'PAUSED') return 'warning';
    if (s === 'ARCHIVED') return 'muted';
    return 'secondary';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Strategies</h2>
          <p className="text-muted-foreground">Define copy-trading strategies bound to your trading accounts.</p>
        </div>
        <Button onClick={openCreate} disabled={accounts.length === 0}>
          <Plus className="h-4 w-4" /> New strategy
        </Button>
      </div>

      {accounts.length === 0 && (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">Add a trading account first to create strategies.</CardContent></Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">No strategies yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-3 pr-4">Name</th>
                    <th className="py-3 pr-4">Account</th>
                    <th className="py-3 pr-4">Visibility</th>
                    <th className="py-3 pr-4">Status</th>
                    <th className="py-3 pr-4">Qty</th>
                    <th className="py-3 pr-4">Followers</th>
                    <th className="py-3 pr-4">Enabled</th>
                    <th className="py-3 pr-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-none">
                      <td className="py-3 pr-4 font-medium">
                        {r.strategyName}
                        {r.masterAccount && <Badge className="ml-2" variant="outline">Master</Badge>}
                      </td>
                      <td className="py-3 pr-4 text-xs text-muted-foreground">
                        {r.tradingAccount?.nickname} · {r.tradingAccount ? BROKER_LABELS[r.tradingAccount.broker] : ''}
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant={r.visibility === 'PUBLIC' ? 'success' : 'muted'}>{r.visibility}</Badge>
                      </td>
                      <td className="py-3 pr-4"><Badge variant={statusVariant(r.status)}>{r.status}</Badge></td>
                      <td className="py-3 pr-4">{r.baseQuantity}</td>
                      <td className="py-3 pr-4">{r.followerCount ?? 0}{r.maxFollowers > 0 && ` / ${r.maxFollowers}`}</td>
                      <td className="py-3 pr-4">
                        <Switch
                          checked={r.enabled}
                          onCheckedChange={async (checked) => { await api.strategies.update(r.id, { enabled: checked }); load(); }}
                        />
                      </td>
                      <td className="py-3 pr-4 text-right space-x-1">
                        <Button size="icon" variant="ghost" onClick={() => openEdit(r)}><Pencil className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" onClick={() => handleDelete(r.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
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
            <DialogTitle>{editingId ? 'Edit strategy' : 'New strategy'}</DialogTitle>
            <DialogDescription>Public strategies appear in the marketplace for other users to follow.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 col-span-2">
                <Label>Strategy name</Label>
                <Input value={form.strategyName} onChange={(e) => setForm({ ...form, strategyName: e.target.value })} required />
              </div>
              <div className="space-y-1.5 col-span-2">
                <Label>Description</Label>
                <Textarea value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Trading account</Label>
                <Select
                  value={form.tradingAccountId}
                  disabled={!!editingId}
                  onChange={(e) => setForm({ ...form, tradingAccountId: e.target.value })}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.nickname} — {BROKER_LABELS[a.broker]}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Visibility</Label>
                <Select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as Visibility })}>
                  {Object.values(Visibility).map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as StrategyStatus })}>
                  {Object.values(StrategyStatus).map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Base quantity</Label>
                <Input type="number" min={1} value={form.baseQuantity} onChange={(e) => setForm({ ...form, baseQuantity: Number(e.target.value) })} />
              </div>
              <div className="space-y-1.5">
                <Label>Max followers (0 = unlimited)</Label>
                <Input type="number" min={0} value={form.maxFollowers} onChange={(e) => setForm({ ...form, maxFollowers: Number(e.target.value) })} />
              </div>
              <div className="flex items-center gap-3 col-span-2 pt-2">
                <Switch checked={!!form.masterAccount} onCheckedChange={(v) => setForm({ ...form, masterAccount: v })} />
                <Label>Master account (source of truth for signals)</Label>
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
