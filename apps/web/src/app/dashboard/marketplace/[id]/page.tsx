'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';

import type { StrategySummaryDto, TradingAccountDto } from '@cts/shared';
import { StrategyIntelligenceLayout } from '@cts/ui';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { BROKER_LABELS } from '@cts/shared';

/**
 * Sprint 6.0 — Strategy Intelligence Dashboard (Follower Marketplace).
 *
 * Same shared layout as the Master Portal detail page. Subscription
 * flow is unchanged — this page just adds the rich profile view and
 * reuses the existing `followers.subscribe` API for the CTA button.
 */
export default function MarketplaceStrategyDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id ? decodeURIComponent(params.id) : '';

  const [summary, setSummary] = useState<StrategySummaryDto | null>(null);
  const [accounts, setAccounts] = useState<TradingAccountDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    tradingAccountId: '',
    multiplier: 1,
    maximumLoss: '',
    maximumDailyLoss: '',
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const [s, a] = await Promise.all([
        api.strategies.summary(id),
        api.tradingAccounts.list(),
      ]);
      setSummary(s);
      setAccounts(a);
      setForm((prev) => ({
        ...prev,
        tradingAccountId: prev.tradingAccountId || a[0]?.id || '',
      }));
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load strategy');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) load();
  }, [id, load]);

  async function handleSubscribe(e: React.FormEvent) {
    e.preventDefault();
    if (!summary) return;
    setSaving(true);
    setError(null);
    try {
      await api.followers.subscribe({
        strategyId: summary.profile.id,
        tradingAccountId: form.tradingAccountId,
        multiplier: Number(form.multiplier),
        maximumLoss: form.maximumLoss ? Number(form.maximumLoss) : undefined,
        maximumDailyLoss: form.maximumDailyLoss
          ? Number(form.maximumDailyLoss)
          : undefined,
      });
      setDialogOpen(false);
      router.push('/dashboard/subscriptions');
    } catch (e: any) {
      setError(e?.message ?? 'Subscription failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Link
            href="/dashboard/marketplace"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
            data-testid="marketplace-detail-back"
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Marketplace
          </Link>
          <h2 className="text-2xl font-bold">Strategy Profile</h2>
        </div>
        <Button
          variant="outline"
          onClick={load}
          disabled={refreshing || !id}
          data-testid="marketplace-detail-refresh-btn"
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <div
          className="text-sm text-destructive"
          data-testid="marketplace-detail-error"
        >
          {error}
        </div>
      ) : !summary ? (
        <div className="text-sm text-muted-foreground">Strategy not found.</div>
      ) : (
        <StrategyIntelligenceLayout
          summary={summary}
          headerActions={
            <Button
              disabled={accounts.length === 0}
              onClick={() => setDialogOpen(true)}
              data-testid="marketplace-detail-subscribe-btn"
            >
              {accounts.length === 0
                ? 'Add trading account first'
                : 'Subscribe'}
            </Button>
          }
        />
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Subscribe to {summary?.profile.strategyName}</DialogTitle>
            <DialogDescription>
              Choose the trading account and risk parameters for this
              subscription.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubscribe} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Trading account</Label>
              <Select
                value={form.tradingAccountId}
                onChange={(e) =>
                  setForm({ ...form, tradingAccountId: e.target.value })
                }
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nickname} — {BROKER_LABELS[a.broker]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Multiplier</Label>
                <Select
                  value={String(form.multiplier)}
                  onChange={(e) =>
                    setForm({ ...form, multiplier: Number(e.target.value) })
                  }
                >
                  {[0.25, 0.5, 1, 2, 5].map((m) => (
                    <option key={m} value={m}>
                      {m}x
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Max loss</Label>
                <Input
                  type="number"
                  value={form.maximumLoss}
                  onChange={(e) =>
                    setForm({ ...form, maximumLoss: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>Max daily loss</Label>
                <Input
                  type="number"
                  value={form.maximumDailyLoss}
                  onChange={(e) =>
                    setForm({ ...form, maximumDailyLoss: e.target.value })
                  }
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Subscribing…' : 'Confirm subscription'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
