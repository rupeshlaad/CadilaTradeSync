'use client';

import * as React from 'react';
import type {
  StrategyOverviewDto,
  StrategyPerformanceDto,
  StrategyProfileDto,
  StrategyRecentActivityDto,
  StrategyRiskDto,
  StrategyRiskLevel,
  StrategyStatus,
  StrategySummaryDto,
} from '@cts/shared';
import { BROKER_LABELS } from '@cts/shared';

/**
 * Sprint 6.0 — Strategy Intelligence Dashboard (Phase 1 — presentation).
 *
 * Pure presentation components shared by the Master Portal and the
 * Follower Marketplace. Use only Tailwind utility classes so both
 * apps render them identically without any additional configuration.
 * No calculations here — every value comes from the shared
 * `StrategySummaryDto` produced by the strategies backend service.
 */

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export const NOT_AVAILABLE_LABEL = 'Not Available';
export const PENDING_IMPORT_LABEL =
  'Data will be available after performance import.';

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return NOT_AVAILABLE_LABEL;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtNumber(v: number | null | undefined): string {
  if (v === null || v === undefined) return NOT_AVAILABLE_LABEL;
  return v.toLocaleString();
}

function fmtPercent(v: number | null | undefined): string {
  if (v === null || v === undefined) return NOT_AVAILABLE_LABEL;
  return `${v.toFixed(2)}%`;
}

function statusTone(status: StrategyStatus): string {
  switch (status) {
    case 'ACTIVE':
      return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-300';
    case 'PAUSED':
      return 'bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-300';
    case 'ARCHIVED':
      return 'bg-muted text-muted-foreground border-transparent';
    case 'DRAFT':
    default:
      return 'bg-secondary text-secondary-foreground border-transparent';
  }
}

function riskTone(level: StrategyRiskLevel | null): string {
  switch (level) {
    case 'LOW':
      return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-300';
    case 'MEDIUM':
      return 'bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-300';
    case 'HIGH':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    default:
      return 'bg-muted text-muted-foreground border-transparent';
  }
}

// ---------------------------------------------------------------------------
// Primitives (kept local so both apps render identically without importing
// their own Card / Badge — the sprint asks for shared UI, not per-app UI).
// ---------------------------------------------------------------------------

interface PanelProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  testid?: string;
  children: React.ReactNode;
}

export function StrategyPanel({
  title,
  description,
  action,
  testid,
  children,
}: PanelProps) {
  return (
    <section
      className="rounded-xl border bg-card text-card-foreground shadow-sm"
      data-testid={testid}
    >
      <header className="flex items-start justify-between gap-4 border-b p-4">
        <div>
          <h3 className="text-base font-semibold leading-none tracking-tight">
            {title}
          </h3>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

interface StatProps {
  label: string;
  value: React.ReactNode;
  tone?: string;
  testid?: string;
}

export function StrategyStat({ label, value, tone, testid }: StatProps) {
  return (
    <div className="rounded-lg border bg-background p-3" data-testid={testid}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

interface RowProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  testid?: string;
}

function KVRow({ label, value, mono, testid }: RowProps) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-40 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`flex-1 break-all text-sm ${mono ? 'font-mono text-xs' : ''}`}
        data-testid={testid}
      >
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export function StrategyStatusBadge({ status }: { status: StrategyStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusTone(status)}`}
      data-testid="strategy-status-badge"
    >
      {status}
    </span>
  );
}

export function StrategyRiskBadge({
  level,
}: {
  level: StrategyRiskLevel | null;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${riskTone(level)}`}
      data-testid="strategy-risk-badge"
    >
      Risk · {level ?? NOT_AVAILABLE_LABEL}
    </span>
  );
}

export function StrategyPerformanceBadge({
  overallReturn,
}: {
  overallReturn: number | null;
}) {
  const tone =
    overallReturn === null
      ? 'bg-muted text-muted-foreground border-transparent'
      : overallReturn >= 0
      ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-300'
      : 'bg-destructive/15 text-destructive border-destructive/30';
  const value = overallReturn === null ? NOT_AVAILABLE_LABEL : fmtPercent(overallReturn);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}
      data-testid="strategy-performance-badge"
    >
      Return · {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Profile header
// ---------------------------------------------------------------------------

export function StrategyProfileHeader({
  profile,
}: {
  profile: StrategyProfileDto;
}) {
  const brokers = profile.supportedBrokers
    .map((b) => BROKER_LABELS[b] ?? b)
    .join(', ');
  const markets =
    profile.supportedMarkets.length > 0
      ? profile.supportedMarkets.join(', ')
      : NOT_AVAILABLE_LABEL;
  return (
    <StrategyPanel
      title={profile.strategyName}
      description={profile.description ?? undefined}
      testid="strategy-profile-header"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <StrategyStatusBadge status={profile.status} />
          <StrategyRiskBadge level={profile.riskLevel} />
        </div>
      }
    >
      <div className="grid gap-2">
        <KVRow
          label="Strategy code"
          value={profile.strategyCode}
          mono
          testid="strategy-profile-code"
        />
        <KVRow
          label="Description"
          value={profile.description ?? NOT_AVAILABLE_LABEL}
        />
        <KVRow label="Status" value={profile.status} />
        <KVRow
          label="Risk level"
          value={profile.riskLevel ?? NOT_AVAILABLE_LABEL}
        />
        <KVRow
          label="Supported brokers"
          value={brokers.length > 0 ? brokers : NOT_AVAILABLE_LABEL}
        />
        <KVRow label="Supported markets" value={markets} />
        <KVRow label="Created" value={fmtDate(profile.createdAt)} />
        <KVRow label="Last updated" value={fmtDate(profile.updatedAt)} />
      </div>
    </StrategyPanel>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function StrategyOverviewCard({
  overview,
}: {
  overview: StrategyOverviewDto;
}) {
  return (
    <StrategyPanel
      title="Overview"
      description="Live subscription + follower counts, derived from existing data"
      testid="strategy-overview-card"
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StrategyStat
          label="Active subscribers"
          value={fmtNumber(overview.activeSubscribers)}
          testid="strategy-overview-active-subscribers"
        />
        <StrategyStat
          label="Active master accounts"
          value={fmtNumber(overview.activeMasterAccounts)}
          testid="strategy-overview-active-masters"
        />
        <StrategyStat
          label="Active followers"
          value={fmtNumber(overview.activeFollowers)}
          testid="strategy-overview-active-followers"
        />
        <StrategyStat
          label="Current status"
          value={overview.currentStatus}
          testid="strategy-overview-current-status"
        />
      </div>
    </StrategyPanel>
  );
}

// ---------------------------------------------------------------------------
// Performance section — placeholders in Phase 1
// ---------------------------------------------------------------------------

export function StrategyPerformanceSection({
  performance,
}: {
  performance: StrategyPerformanceDto;
}) {
  const anyPopulated = [
    performance.todayReturn,
    performance.weeklyReturn,
    performance.monthlyReturn,
    performance.overallReturn,
    performance.winRate,
    performance.totalTrades,
    performance.capitalManaged,
  ].some((v) => v !== null);

  return (
    <StrategyPanel
      title="Performance"
      description="Historical returns and trade statistics"
      testid="strategy-performance-section"
    >
      {!anyPopulated ? (
        <div
          className="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
          data-testid="strategy-performance-placeholder"
        >
          {PENDING_IMPORT_LABEL}
        </div>
      ) : null}
      <div
        className={`grid grid-cols-2 md:grid-cols-4 gap-3 ${
          !anyPopulated ? 'opacity-60 mt-4' : ''
        }`}
      >
        <StrategyStat
          label="Today's return"
          value={fmtPercent(performance.todayReturn)}
        />
        <StrategyStat
          label="Weekly return"
          value={fmtPercent(performance.weeklyReturn)}
        />
        <StrategyStat
          label="Monthly return"
          value={fmtPercent(performance.monthlyReturn)}
        />
        <StrategyStat
          label="Overall return"
          value={fmtPercent(performance.overallReturn)}
        />
        <StrategyStat
          label="Win rate"
          value={fmtPercent(performance.winRate)}
        />
        <StrategyStat
          label="Total trades"
          value={fmtNumber(performance.totalTrades)}
        />
        <StrategyStat
          label="Capital managed"
          value={fmtNumber(performance.capitalManaged)}
        />
        <StrategyStat
          label="Last updated"
          value={fmtDate(performance.lastUpdated)}
        />
      </div>
    </StrategyPanel>
  );
}

// ---------------------------------------------------------------------------
// Subscribers section — driven off overview data (no separate list yet)
// ---------------------------------------------------------------------------

export function StrategySubscribersSection({
  overview,
}: {
  overview: StrategyOverviewDto;
}) {
  return (
    <StrategyPanel
      title="Subscribers"
      description="Subscriber &amp; follower distribution"
      testid="strategy-subscribers-section"
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StrategyStat
          label="Active subscribers"
          value={fmtNumber(overview.activeSubscribers)}
        />
        <StrategyStat
          label="Active followers"
          value={fmtNumber(overview.activeFollowers)}
        />
        <StrategyStat
          label="Master accounts running"
          value={fmtNumber(overview.activeMasterAccounts)}
        />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Detailed subscriber roster will be available after performance import.
      </p>
    </StrategyPanel>
  );
}

// ---------------------------------------------------------------------------
// Risk section — placeholders in Phase 1
// ---------------------------------------------------------------------------

export function StrategyRiskSection({ risk }: { risk: StrategyRiskDto }) {
  const hasData =
    risk.riskLevel !== null ||
    risk.maxDrawdown !== null ||
    risk.volatility !== null ||
    risk.notes.length > 0;

  return (
    <StrategyPanel
      title="Risk"
      description="Drawdown &amp; volatility metrics"
      testid="strategy-risk-section"
    >
      {!hasData ? (
        <div
          className="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
          data-testid="strategy-risk-placeholder"
        >
          {PENDING_IMPORT_LABEL}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <StrategyStat
            label="Risk level"
            value={risk.riskLevel ?? NOT_AVAILABLE_LABEL}
          />
          <StrategyStat
            label="Max drawdown"
            value={fmtPercent(risk.maxDrawdown)}
          />
          <StrategyStat
            label="Volatility"
            value={fmtPercent(risk.volatility)}
          />
        </div>
      )}
      {risk.notes.length > 0 && (
        <ul className="mt-3 list-disc pl-6 text-sm text-muted-foreground">
          {risk.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </StrategyPanel>
  );
}

// ---------------------------------------------------------------------------
// Recent activity section — placeholders in Phase 1
// ---------------------------------------------------------------------------

export function StrategyRecentActivitySection({
  activity,
}: {
  activity: StrategyRecentActivityDto;
}) {
  if (activity.items.length === 0) {
    return (
      <StrategyPanel
        title="Recent Activity"
        description="Latest lifecycle events for this strategy"
        testid="strategy-recent-activity-section"
      >
        <div
          className="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
          data-testid="strategy-recent-activity-placeholder"
        >
          {PENDING_IMPORT_LABEL}
        </div>
      </StrategyPanel>
    );
  }
  return (
    <StrategyPanel
      title="Recent Activity"
      description="Latest lifecycle events for this strategy"
      testid="strategy-recent-activity-section"
    >
      <ol className="relative border-l pl-4 space-y-3">
        {activity.items.map((item, i) => (
          <li key={`${item.at}-${i}`} className="ml-2">
            <div className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border bg-background" />
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {item.kind.replace(/_/g, ' ')}
            </div>
            <div className="text-sm">{item.label}</div>
            <div className="text-[11px] text-muted-foreground">
              {fmtDate(item.at)}
            </div>
          </li>
        ))}
      </ol>
    </StrategyPanel>
  );
}

// ---------------------------------------------------------------------------
// AI Insights — Coming Soon placeholder
// ---------------------------------------------------------------------------

export function StrategyAIInsightsSection() {
  return (
    <StrategyPanel
      title="AI Insights"
      description="Candila AI commentary on this strategy"
      testid="strategy-ai-insights-section"
      action={
        <span
          className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
          data-testid="strategy-ai-insights-coming-soon"
        >
          Coming Soon
        </span>
      }
    >
      <p className="text-sm text-muted-foreground">
        Candila AI-generated commentary, regime tagging and risk narratives
        will appear here once the AI integration ships.
      </p>
    </StrategyPanel>
  );
}

// ---------------------------------------------------------------------------
// Composed layout — reusable by Master Portal + Follower Marketplace
// ---------------------------------------------------------------------------

export interface StrategyIntelligenceLayoutProps {
  summary: StrategySummaryDto;
  /** Optional slot rendered inside the profile header (subscribe button, etc). */
  headerActions?: React.ReactNode;
  /** Optional slot rendered below the profile header (e.g. owner-only controls). */
  belowHeader?: React.ReactNode;
}

export function StrategyIntelligenceLayout({
  summary,
  headerActions,
  belowHeader,
}: StrategyIntelligenceLayoutProps) {
  return (
    <div
      className="space-y-6"
      data-testid="strategy-intelligence-layout"
    >
      <div className="grid grid-cols-1 gap-6">
        <div className="relative">
          <StrategyProfileHeader profile={summary.profile} />
          {headerActions && (
            <div className="mt-3 flex flex-wrap gap-2">{headerActions}</div>
          )}
        </div>
        {belowHeader}
      </div>
      <StrategyOverviewCard overview={summary.overview} />
      <StrategyPerformanceSection performance={summary.performance} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <StrategySubscribersSection overview={summary.overview} />
        <StrategyRiskSection risk={summary.risk} />
      </div>
      <StrategyRecentActivitySection activity={summary.recentActivity} />
      <StrategyAIInsightsSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Marketplace card — reusable enhancement for the Follower Marketplace grid
// ---------------------------------------------------------------------------

export interface StrategyMarketplaceCardProps {
  strategy: {
    id: string;
    strategyName: string;
    description: string | null;
    status: StrategyStatus;
    followerCount?: number;
    maxFollowers: number;
    baseQuantity: number;
    tradingAccount?: { broker: keyof typeof BROKER_LABELS } | null;
  };
  riskLevel?: StrategyRiskLevel | null;
  overallReturn?: number | null;
  /** Rendered as the action button. */
  actionSlot?: React.ReactNode;
  /** Link target (Master detail, Marketplace detail, etc). */
  detailHref?: string;
  onOpenDetail?: () => void;
}

export function StrategyMarketplaceCard({
  strategy,
  riskLevel = null,
  overallReturn = null,
  actionSlot,
  detailHref,
  onOpenDetail,
}: StrategyMarketplaceCardProps) {
  const subs = strategy.followerCount ?? 0;
  const capacity =
    strategy.maxFollowers > 0 ? ` / ${strategy.maxFollowers}` : '';
  return (
    <div
      className="rounded-xl border bg-card text-card-foreground shadow-sm flex flex-col"
      data-testid={`strategy-marketplace-card-${strategy.id}`}
    >
      <div className="p-4 border-b space-y-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-lg font-semibold leading-tight">
            {strategy.strategyName}
          </h3>
          <StrategyStatusBadge status={strategy.status} />
        </div>
        <div className="text-xs text-muted-foreground">
          {strategy.tradingAccount
            ? BROKER_LABELS[strategy.tradingAccount.broker]
            : NOT_AVAILABLE_LABEL}
          {' · '}base qty {strategy.baseQuantity}
        </div>
        <div className="flex flex-wrap gap-2">
          <StrategyRiskBadge level={riskLevel} />
          <StrategyPerformanceBadge overallReturn={overallReturn} />
        </div>
      </div>
      <div className="p-4 space-y-3 grow">
        <p className="text-sm text-muted-foreground line-clamp-3">
          {strategy.description ?? 'No description.'}
        </p>
        <div className="text-xs text-muted-foreground">
          {subs}
          {capacity} followers
        </div>
      </div>
      <div className="p-4 border-t flex flex-wrap gap-2">
        {actionSlot}
        {(detailHref || onOpenDetail) && (
          <a
            href={detailHref}
            onClick={(e) => {
              if (!detailHref && onOpenDetail) {
                e.preventDefault();
                onOpenDetail();
              }
            }}
            className="inline-flex items-center text-xs text-primary hover:underline"
            data-testid={`strategy-marketplace-card-${strategy.id}-detail`}
          >
            View profile →
          </a>
        )}
      </div>
    </div>
  );
}
