'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BROKER_LABELS, type FollowerDto } from '@cts/shared';

export default function AdminFollowersPage() {
  const [rows, setRows] = useState<FollowerDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.admin.listFollowers()
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardHeader><CardTitle>All Followers</CardTitle></CardHeader>
      <CardContent>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!loading && !error && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-2 pr-4">Follower</th>
                  <th className="py-2 pr-4">Strategy</th>
                  <th className="py-2 pr-4">Trading Account</th>
                  <th className="py-2 pr-4">Multiplier</th>
                  <th className="py-2 pr-4">Max Loss</th>
                  <th className="py-2 pr-4">Enabled</th>
                  <th className="py-2 pr-4">Since</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.id} className="border-b last:border-none">
                    <td className="py-2 pr-4">{f.followerUser?.email ?? f.followerUserId}</td>
                    <td className="py-2 pr-4">{f.strategy?.strategyName}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {f.tradingAccount?.nickname} · {f.tradingAccount ? BROKER_LABELS[f.tradingAccount.broker] : ''}
                    </td>
                    <td className="py-2 pr-4">{f.multiplier}x</td>
                    <td className="py-2 pr-4">{f.maximumLoss ?? '—'}</td>
                    <td className="py-2 pr-4"><Badge variant={f.enabled ? 'success' : 'destructive'}>{f.enabled ? 'ON' : 'OFF'}</Badge></td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">{new Date(f.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
