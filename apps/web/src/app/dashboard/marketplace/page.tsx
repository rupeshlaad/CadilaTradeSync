'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StrategyMarketplaceCard } from '@cts/ui';
import { BROKER_LABELS, type StrategyDto, type TradingAccountDto } from '@cts/shared';

export default function MarketplacePage() {
  const [rows, setRows] = useState<StrategyDto[]>([]);
  const [accounts, setAccounts] = useState<TradingAccountDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<StrategyDto | null>(null);
  const [form, setForm] = useState({ tradingAccountId: '', multiplier: 1, maximumLoss: '', maximumDailyLoss: '' });
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setLoading(true);
      const [m, a] = await Promise.all([api.strategies.marketplace(), api.tradingAccounts.list()]);
      setRows(m);
      setAccounts(a);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function openSubscribe(s: StrategyDto) {
    setTarget(s);
    setForm({ tradingAccountId: accounts[0]?.id ?? '', multiplier: 1, maximumLoss: '', maximumDailyLoss: '' });
    setOpen(true);
  }

  async function handleSubscribe(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setSaving(true);
    setError(null);
    try {
      await api.followers.subscribe({
        strategyId: target.id,
        tradingAccountId: form.tradingAccountId,
        multiplier: Number(form.multiplier),
        maximumLoss: form.maximumLoss ? Number(form.maximumLoss) : undefined,
        maximumDailyLoss: form.maximumDailyLoss ? Number(form.maximumDailyLoss) : undefined,
      });
      setOpen(false);
      alert('Subscribed successfully.');
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Marketplace</h2>
        <p className="text-muted-foreground">Discover and subscribe to public strategies from other traders.</p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">No public strategies available yet.</CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {rows.map((s) => (
            <StrategyMarketplaceCard
              key={s.id}
              strategy={s}
              /* Sprint 6.0 — risk/performance placeholders. Populated in a future sprint. */
              riskLevel={null}
              overallReturn={null}
              detailHref={`/dashboard/marketplace/${s.id}`}
              actionSlot={
                <Button
                  disabled={accounts.length === 0}
                  onClick={() => openSubscribe(s)}
                  data-testid={`marketplace-subscribe-btn-${s.id}`}
                >
                  {accounts.length === 0 ? 'Add trading account first' : 'Subscribe'}
                </Button>
              }
            />
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Subscribe to {target?.strategyName}</DialogTitle>
            <DialogDescription>Choose the trading account and risk parameters for this subscription.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubscribe} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Trading account</Label>
              <Select value={form.tradingAccountId} onChange={(e) => setForm({ ...form, tradingAccountId: e.target.value })}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.nickname} — {BROKER_LABELS[a.broker]}</option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Multiplier</Label>
                <Select value={String(form.multiplier)} onChange={(e) => setForm({ ...form, multiplier: Number(e.target.value) })}>
                  {[0.25, 0.5, 1, 2, 5].map((m) => <option key={m} value={m}>{m}x</option>)}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Max loss</Label>
                <Input type="number" value={form.maximumLoss} onChange={(e) => setForm({ ...form, maximumLoss: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Max daily loss</Label>
                <Input type="number" value={form.maximumDailyLoss} onChange={(e) => setForm({ ...form, maximumDailyLoss: e.target.value })} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? 'Subscribing…' : 'Confirm subscription'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
