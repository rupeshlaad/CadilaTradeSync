'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { SubscriptionDto } from '@cts/shared';

export default function SubscriptionsPage() {
  const [rows, setRows] = useState<SubscriptionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setRows(await api.subscriptions.list());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function cancel(id: string) {
    if (!confirm('Cancel this subscription?')) return;
    await api.subscriptions.cancel(id);
    await load();
  }

  const variant = (s: string): 'success' | 'muted' | 'warning' | 'destructive' => {
    if (s === 'ACTIVE') return 'success';
    if (s === 'TRIAL') return 'warning';
    if (s === 'CANCELLED') return 'destructive';
    return 'muted';
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Subscriptions</h2>
        <p className="text-muted-foreground">Your subscriptions to public strategies.</p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Card>
        <CardHeader>
          <CardTitle>Active & past subscriptions</CardTitle>
          <CardDescription>Trial subscriptions are auto-created when you follow a public strategy.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <p className="text-muted-foreground">Loading…</p> : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No subscriptions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4">Strategy</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Start</th>
                    <th className="py-2 pr-4">End</th>
                    <th className="py-2 pr-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} className="border-b last:border-none">
                      <td className="py-2 pr-4 font-medium">{s.strategy?.strategyName}</td>
                      <td className="py-2 pr-4"><Badge variant={variant(s.status)}>{s.status}</Badge></td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{new Date(s.startDate).toLocaleString()}</td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{s.endDate ? new Date(s.endDate).toLocaleString() : '—'}</td>
                      <td className="py-2 pr-4 text-right">
                        {(s.status === 'ACTIVE' || s.status === 'TRIAL') && (
                          <Button size="sm" variant="outline" onClick={() => cancel(s.id)}>Cancel</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
