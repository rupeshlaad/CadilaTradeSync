'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { BROKER_LABELS, type StrategyDto } from '@cts/shared';

export default function AdminStrategiesPage() {
  const [rows, setRows] = useState<(StrategyDto & { tradingAccount?: any })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [masterAccounts, setMasterAccounts] = useState<any[]>([]);

  const emptyForm = {
    strategyName: '',
    description: '',
    tradingAccountId: '',
    visibility: 'PRIVATE',
    baseQuantity: 1,
    maxFollowers: 0,
    status: 'ACTIVE',
    enabled: true,
  };

  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    api.admin.listStrategies()
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));

    api.admin.masterAccounts
      .list()
      .then(setMasterAccounts);
  }, []);

  const statusVariant = (s: string): 'success' | 'warning' | 'muted' | 'secondary' => {
    if (s === 'ACTIVE') return 'success';
    if (s === 'PAUSED') return 'warning';
    if (s === 'ARCHIVED') return 'muted';
    return 'secondary';
  };

  async function saveStrategy() {
    try {
      setSaving(true);
      if (editingId) {
        await api.admin.strategies.update(editingId, form);
      } else {
        await api.admin.strategies.create(form);
      }
      const data = await api.admin.listStrategies();
      setRows(data);
      setOpen(false);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Strategies</h2>
          <p className="text-muted-foreground">Manage copy trading strategies.</p>
        </div>
        <Button
          onClick={() => {
            setEditingId(null);
            setForm(emptyForm);
            setOpen(true);
          }}
        >
          + New Strategy
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle>All Strategies</CardTitle></CardHeader>
        <CardContent>
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!loading && !error && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4">Owner</th>
                    <th className="py-2 pr-4">Strategy</th>
                    <th className="py-2 pr-4">Account</th>
                    <th className="py-2 pr-4">Visibility</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Followers</th>
                    <th className="py-2 pr-4">Enabled</th>
                    <th className="py-2 pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} className="border-b last:border-none">
                      <td className="py-2 pr-4">{s.tradingAccount?.user?.email ?? '—'}</td>
                      <td className="py-2 pr-4 font-medium">{s.strategyName}</td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {s.tradingAccount?.nickname} · {s.tradingAccount ? BROKER_LABELS[s.tradingAccount.broker as keyof typeof BROKER_LABELS] : ''}
                      </td>
                      <td className="py-2 pr-4"><Badge variant={s.visibility === 'PUBLIC' ? 'success' : 'muted'}>{s.visibility}</Badge></td>
                      <td className="py-2 pr-4"><Badge variant={statusVariant(s.status)}>{s.status}</Badge></td>
                      <td className="py-2 pr-4">{s.followerCount ?? 0}</td>
                      <td className="py-2 pr-4"><Badge variant={s.enabled ? 'success' : 'destructive'}>{s.enabled ? 'ON' : 'OFF'}</Badge></td>
                      <td className="py-2 pr-4">
                        <div className="flex gap-2">
                          <Link
                            href={`/dashboard/strategies/${s.id}`}
                            className="inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
                            data-testid={`admin-strategies-profile-link-${s.id}`}
                          >
                            Profile
                          </Link>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditingId(s.id);
                              setForm({
                                strategyName: s.strategyName,
                                description: s.description ?? '',
                                tradingAccountId: s.tradingAccountId,
                                visibility: s.visibility,
                                baseQuantity: s.baseQuantity,
                                maxFollowers: s.maxFollowers,
                                status: s.status,
                                enabled: s.enabled,
                              });
                              setOpen(true);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={async () => {
                              if (!confirm('Delete this strategy?')) {
                                return;
                              }
                              await api.admin.strategies.remove(s.id);
                              const data = await api.admin.listStrategies();
                              setRows(data);
                            }}
                          >
                            Delete
                          </Button>
                        </div>
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
            <DialogTitle>
              {editingId ? 'Edit Strategy' : 'Create Strategy'}
            </DialogTitle>
            <DialogDescription>
              Configure a copy trading strategy.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Strategy Name</Label>
              <Input
                value={form.strategyName}
                onChange={(e) =>
                  setForm({
                    ...form,
                    strategyName: e.target.value,
                  })
                }
              />
            </div>
            <div>
              <Label>Description</Label>
              <Input
                value={form.description}
                onChange={(e) =>
                  setForm({
                    ...form,
                    description: e.target.value,
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Visibility</Label>
              <Select
                value={form.visibility}
                onChange={(e) =>
                  setForm({
                    ...form,
                    visibility: e.target.value,
                  })
                }
              >
                <option value="PRIVATE">Private</option>
                <option value="PUBLIC">Public</option>
              </Select>
            </div>
            <div>
              <Label>Master Account</Label>
              <Select
                value={form.tradingAccountId}
                onChange={(e) =>
                  setForm({
                    ...form,
                    tradingAccountId: e.target.value,
                  })
                }
              >
                <option value="">Select Master Account</option>
                {masterAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nickname}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Base Quantity</Label>
              <Input
                type="number"
                value={form.baseQuantity}
                onChange={(e) =>
                  setForm({
                    ...form,
                    baseQuantity: Number(e.target.value),
                  })
                }
              />
            </div>
            <div>
              <Label>Enabled</Label>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v: boolean) =>
                  setForm({
                    ...form,
                    enabled: v,
                  })
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveStrategy} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}