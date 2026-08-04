'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';

import type { StrategySummaryDto } from '@cts/shared';
import { StrategyIntelligenceLayout } from '@cts/ui';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

/**
 * Sprint 6.0 — Strategy Intelligence Dashboard (Master Portal).
 *
 * Presentation-only detail page for a single Strategy, backed by the
 * new `GET /admin/strategies/:id/summary` endpoint and rendered
 * entirely through the shared `@cts/ui` StrategyIntelligenceLayout
 * (same layout used by the Follower Marketplace detail page).
 */
export default function AdminStrategyDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ? decodeURIComponent(params.id) : '';

  const [summary, setSummary] = useState<StrategySummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const s = await api.admin.strategies.summary(id);
      setSummary(s);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load strategy summary');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) load();
  }, [id, load]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Link
            href="/dashboard/strategies"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
            data-testid="admin-strategy-detail-back"
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Strategies
          </Link>
          <h2 className="text-2xl font-bold">Strategy Profile</h2>
          <p
            className="text-muted-foreground font-mono text-xs"
            data-testid="admin-strategy-detail-id"
          >
            {id}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={load}
          disabled={refreshing || !id}
          data-testid="admin-strategy-detail-refresh-btn"
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
          data-testid="admin-strategy-detail-error"
        >
          {error}
        </div>
      ) : !summary ? (
        <div className="text-sm text-muted-foreground">Strategy not found.</div>
      ) : (
        <StrategyIntelligenceLayout summary={summary} />
      )}
    </div>
  );
}
