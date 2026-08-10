'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import {
  FollowerDashboardHeader,
  OnboardingProgressWidget,
} from '@cts/ui';
import type {
  FollowerDashboardSummaryDto,
  FollowerOnboardingStatusDto,
} from '@cts/shared';

import { api } from '@/lib/api';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * Sprint 6.1 — Follower Dashboard root.
 *
 * Header + onboarding widget only; portfolio / P&L / risk-engine
 * calculations remain out of scope for this sprint. Both widgets
 * come from the shared @cts/ui package so the same components will
 * be usable by future admin-side views.
 */
export default function DashboardHome() {
  const [summary, setSummary] = useState<FollowerDashboardSummaryDto | null>(
    null,
  );
  const [onboarding, setOnboarding] =
    useState<FollowerOnboardingStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [s, o] = await Promise.all([
        api.follower.dashboardSummary(),
        api.follower.onboardingStatus(),
      ]);
      setSummary(s);
      setOnboarding(o);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Welcome to Candila TradeSync</h2>
        <p className="text-muted-foreground">Enterprise Multi-Broker Copy Trading Platform</p>
      </div>
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <div className="text-sm text-destructive" data-testid="follower-dashboard-error">
          {error}
        </div>
      ) : (
        <>
          {summary && <FollowerDashboardHeader summary={summary} />}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              {onboarding && (
                <OnboardingProgressWidget
                  status={onboarding}
                  onStepClick={(step) => {
                    if (step === 'BROKER')
                      window.location.href = '/dashboard/broker-accounts';
                    else if (step === 'STRATEGY')
                      window.location.href = '/dashboard/marketplace';
                    else if (step === 'RISK')
                      window.location.href = '/dashboard/subscriptions';
                    else if (step === 'PROFILE')
                      window.location.href = '/dashboard/settings';
                  }}
                />
              )}
            </div>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Quick Links</CardTitle>
                <CardDescription>
                  Jump into the most common tasks.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <QuickLink href="/dashboard/broker-accounts" label="Manage broker accounts" />
                <QuickLink href="/dashboard/marketplace" label="Browse strategy marketplace" />
                <QuickLink href="/dashboard/subscriptions" label="Review your subscriptions" />
                <QuickLink href="/dashboard/reports" label="View reports (coming soon)" />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function QuickLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between rounded-md border px-3 py-2 hover:bg-accent hover:text-accent-foreground"
    >
      <span>{label}</span>
      <span aria-hidden>→</span>
    </Link>
  );
}
