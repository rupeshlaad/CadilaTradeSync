'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { BROKER_LABELS, type FollowerDto } from '@cts/shared';

export default function FollowersPage() {
  const [asOwner, setAsOwner] = useState<FollowerDto[]>([]);
  const [mine, setMine] = useState<FollowerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      const [a, b] = await Promise.all([api.followers.listAsOwner(), api.followers.listMine()]);
      setAsOwner(a);
      setMine(b);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function unsubscribe(id: string) {
    if (!confirm('Unsubscribe from this strategy?')) return;
    await api.followers.unsubscribe(id);
    await load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Followers</h2>
        <p className="text-muted-foreground">Users following your strategies, and strategies you follow.</p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Followers of my strategies</CardTitle>
          <CardDescription>People subscribing to strategies you own.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <p className="text-muted-foreground">Loading…</p> : asOwner.length === 0 ? (
            <p className="text-sm text-muted-foreground">No followers yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4">Follower</th>
                    <th className="py-2 pr-4">Strategy</th>
                    <th className="py-2 pr-4">Multiplier</th>
                    <th className="py-2 pr-4">Max loss</th>
                    <th className="py-2 pr-4">Enabled</th>
                    <th className="py-2 pr-4">Since</th>
                  </tr>
                </thead>
                <tbody>
                  {asOwner.map((f) => (
                    <tr key={f.id} className="border-b last:border-none">
                      <td className="py-2 pr-4">{f.followerUser?.email}</td>
                      <td className="py-2 pr-4">{f.strategy?.strategyName}</td>
                      <td className="py-2 pr-4">{f.multiplier}x</td>
                      <td className="py-2 pr-4">{f.maximumLoss ?? '—'}</td>
                      <td className="py-2 pr-4">
                        <Badge variant={f.enabled ? 'success' : 'muted'}>{f.enabled ? 'ON' : 'OFF'}</Badge>
                      </td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{new Date(f.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Strategies I follow</CardTitle>
          <CardDescription>Public strategies you are subscribed to.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <p className="text-muted-foreground">Loading…</p> : mine.length === 0 ? (
            <p className="text-sm text-muted-foreground">You are not following any strategies. Browse the Marketplace.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4">Strategy</th>
                    <th className="py-2 pr-4">Trading account</th>
                    <th className="py-2 pr-4">Multiplier</th>
                    <th className="py-2 pr-4">Since</th>
                    <th className="py-2 pr-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((f) => (
                    <tr key={f.id} className="border-b last:border-none">
                      <td className="py-2 pr-4 font-medium">{f.strategy?.strategyName}</td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {f.tradingAccount?.nickname} · {f.tradingAccount ? BROKER_LABELS[f.tradingAccount.broker] : ''}
                      </td>
                      <td className="py-2 pr-4">{f.multiplier}x</td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{new Date(f.createdAt).toLocaleString()}</td>
                      <td className="py-2 pr-4 text-right">
                        <Button size="sm" variant="ghost" onClick={() => unsubscribe(f.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" /> Unsubscribe
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
    </div>
  );
}
