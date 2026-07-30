'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BROKER_LABELS, type StrategyDto } from '@cts/shared';

export default function AdminStrategiesPage() {
  const [rows, setRows] = useState<(StrategyDto & { tradingAccount?: any })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.admin.listStrategies()
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const statusVariant = (s: string): 'success' | 'warning' | 'muted' | 'secondary' => {
    if (s === 'ACTIVE') return 'success';
    if (s === 'PAUSED') return 'warning';
    if (s === 'ARCHIVED') return 'muted';
    return 'secondary';
  };

  return (
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
