'use client';

import * as React from 'react';
import type {
  BrokerConnectionState,
  FollowerDashboardSummaryDto,
  FollowerOnboardingStatusDto,
} from '@cts/shared';

/**
 * Sprint 6.1 — Shared broker + onboarding UI, consumed by both the
 * Master (admin) and Follower (web) portals. Pure presentation
 * components with Tailwind utility classes so the two apps stay
 * visually consistent without duplicating JSX.
 */

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// ---------------------------------------------------------------------------
// BrokerConnectionBadge
// ---------------------------------------------------------------------------

function connectionTone(state: BrokerConnectionState): string {
  switch (state) {
    case 'CONNECTED':
      return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-300';
    case 'EXPIRED':
      return 'bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-300';
    case 'RECONNECTING':
      return 'bg-sky-500/15 text-sky-700 border-sky-500/30 dark:text-sky-300';
    case 'ERROR':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    case 'DISCONNECTED':
    default:
      return 'bg-muted text-muted-foreground border-transparent';
  }
}

export function BrokerConnectionBadge({
  state,
}: {
  state: BrokerConnectionState;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${connectionTone(state)}`}
      data-testid="broker-connection-badge"
    >
      {state.replace(/_/g, ' ')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// BrokerAccountCard
// ---------------------------------------------------------------------------

export interface BrokerAccountCardData {
  id: string;
  broker: string;
  brokerLabel: string;
  nickname: string;
  clientId: string;
  connectionState: BrokerConnectionState;
  enabled: boolean;
  lastHeartbeat: string | null;
  /** Sprint 6.1.1 — Last successful broker login timestamp. */
  lastLogin: string | null;
  createdAt: string | null;
  hasApiKey: boolean;
  hasApiSecret: boolean;
  hasPassword: boolean;
  hasTotpSecret: boolean;
  /** Sprint 6.1.1 — Session health snapshot for the badge row. */
  sessionHealth?: BrokerSessionHealth | null;
  /** Optional details section — accountHolder / exchange / product / connection / refresh. */
  details?: BrokerAccountDetails | null;
}

export interface BrokerSessionHealth {
  healthy: boolean;
  sessionActive: boolean;
  tokenExpired: boolean | null;
  lastCheckedAt: string | null;
}

export interface BrokerAccountDetails {
  accountHolder?: string | null;
  exchanges?: string[] | null;
  products?: string[] | null;
  connectionTime?: string | null;
  lastRefresh?: string | null;
}

export interface BrokerAccountCardProps {
  account: BrokerAccountCardData;
  onConnect?: (account: BrokerAccountCardData) => void;
  onReconnect?: (account: BrokerAccountCardData) => void;
  onDisconnect?: (account: BrokerAccountCardData) => void;
  onEdit?: (account: BrokerAccountCardData) => void;
  onRemove?: (account: BrokerAccountCardData) => void;
  onToggleEnabled?: (account: BrokerAccountCardData) => void;
  onRefreshHealth?: (account: BrokerAccountCardData) => void;
  showDetails?: boolean;
  onToggleDetails?: () => void;
}

export function BrokerAccountCard({
  account,
  onConnect,
  onReconnect,
  onDisconnect,
  onEdit,
  onRemove,
  onToggleEnabled,
  onRefreshHealth,
  showDetails,
  onToggleDetails,
}: BrokerAccountCardProps) {
  const isConnected = account.connectionState === 'CONNECTED';
  const primaryAction = isConnected
    ? onReconnect
      ? {
          label: 'Reconnect',
          handler: () => onReconnect(account),
          variant: 'outline' as const,
          testid: `broker-account-${account.id}-reconnect`,
        }
      : null
    : onConnect
    ? {
        label: account.connectionState === 'ERROR' ? 'Retry connect' : 'Connect',
        handler: () => onConnect(account),
        variant: 'primary' as const,
        testid: `broker-account-${account.id}-connect`,
      }
    : null;

  const credentials = [
    account.hasApiKey && 'API Key',
    account.hasApiSecret && 'Secret',
    account.hasPassword && 'Password',
    account.hasTotpSecret && 'TOTP',
  ]
    .filter(Boolean)
    .join(' · ') || '—';

  return (
    <div
      className="rounded-xl border bg-card text-card-foreground shadow-sm"
      data-testid={`broker-account-card-${account.id}`}
    >
      <div className="p-4 border-b flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold">{account.nickname}</h3>
            <span className="text-xs text-muted-foreground">
              {account.brokerLabel}
            </span>
          </div>
          <div className="text-xs text-muted-foreground font-mono mt-1">
            {account.clientId}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BrokerConnectionBadge state={account.connectionState} />
          {!account.enabled && (
            <span className="inline-flex items-center rounded-full border border-transparent bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
              DISABLED
            </span>
          )}
        </div>
      </div>

      <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Broker
          </div>
          <div>{account.brokerLabel}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Client ID
          </div>
          <div className="font-mono text-xs">{account.clientId}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Last Login
          </div>
          <div data-testid={`broker-account-${account.id}-last-login`}>
            {fmtTime(account.lastLogin)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Last Sync
          </div>
          <div data-testid={`broker-account-${account.id}-last-sync`}>
            {fmtTime(account.lastHeartbeat)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Session Health
          </div>
          <div
            className="flex items-center gap-2"
            data-testid={`broker-account-${account.id}-session-health`}
          >
            {account.sessionHealth ? (
              <>
                <span
                  className={`inline-flex h-2.5 w-2.5 rounded-full ${
                    account.sessionHealth.healthy
                      ? 'bg-emerald-500'
                      : 'bg-destructive'
                  }`}
                  aria-hidden
                />
                <span className="text-xs">
                  {account.sessionHealth.healthy ? 'Healthy' : 'Attention'}
                  {account.sessionHealth.tokenExpired ? ' · expired' : ''}
                </span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Credentials
          </div>
          <div className="text-xs">{credentials}</div>
        </div>
      </div>

      {showDetails && account.details && (
        <div
          className="border-t px-4 py-3 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm"
          data-testid={`broker-account-card-${account.id}-details`}
        >
          <DetailRow
            label="Account holder"
            value={account.details.accountHolder ?? '—'}
          />
          <DetailRow
            label="Exchanges"
            value={
              account.details.exchanges && account.details.exchanges.length > 0
                ? account.details.exchanges.join(', ')
                : '—'
            }
          />
          <DetailRow
            label="Products"
            value={
              account.details.products && account.details.products.length > 0
                ? account.details.products.join(', ')
                : '—'
            }
          />
          <DetailRow
            label="Connection time"
            value={fmtTime(account.details.connectionTime)}
          />
          <DetailRow
            label="Last refresh"
            value={fmtTime(account.details.lastRefresh)}
          />
        </div>
      )}

      <div className="border-t p-3 flex flex-wrap items-center gap-2">
        {primaryAction && (
          <ActionButton
            label={primaryAction.label}
            variant={primaryAction.variant}
            onClick={primaryAction.handler}
            testid={primaryAction.testid}
          />
        )}
        {isConnected && onDisconnect && (
          <ActionButton
            label="Disconnect"
            variant="destructive"
            onClick={() => onDisconnect(account)}
            testid={`broker-account-${account.id}-disconnect`}
          />
        )}
        {onRefreshHealth && (
          <ActionButton
            label="Refresh health"
            variant="ghost"
            onClick={() => onRefreshHealth(account)}
            testid={`broker-account-${account.id}-refresh-health`}
          />
        )}
        {onEdit && (
          <ActionButton
            label="Edit"
            variant="ghost"
            onClick={() => onEdit(account)}
            testid={`broker-account-${account.id}-edit`}
          />
        )}
        {onToggleEnabled && (
          <ActionButton
            label={account.enabled ? 'Disable' : 'Enable'}
            variant="ghost"
            onClick={() => onToggleEnabled(account)}
            testid={`broker-account-${account.id}-toggle-enabled`}
          />
        )}
        {onToggleDetails && (
          <ActionButton
            label={showDetails ? 'Hide details' : 'View details'}
            variant="ghost"
            onClick={onToggleDetails}
            testid={`broker-account-${account.id}-toggle-details`}
          />
        )}
        {onRemove && (
          <ActionButton
            label="Delete"
            variant="destructive"
            onClick={() => onRemove(account)}
            testid={`broker-account-${account.id}-remove`}
          />
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div>{value}</div>
    </div>
  );
}

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'destructive';

function ActionButton({
  label,
  onClick,
  variant,
  testid,
}: {
  label: string;
  onClick: () => void;
  variant: ButtonVariant;
  testid?: string;
}) {
  const cls =
    variant === 'primary'
      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
      : variant === 'outline'
      ? 'border bg-background hover:bg-accent hover:text-accent-foreground'
      : variant === 'destructive'
      ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
      : 'text-muted-foreground hover:text-foreground hover:bg-accent';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${cls}`}
      data-testid={testid}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// OnboardingProgressWidget
// ---------------------------------------------------------------------------

export function OnboardingProgressWidget({
  status,
  onStepClick,
}: {
  status: FollowerOnboardingStatusDto;
  onStepClick?: (key: FollowerOnboardingStatusDto['steps'][number]['key']) => void;
}) {
  const pct = Math.round((status.completedCount / status.totalCount) * 100);
  return (
    <section
      className="rounded-xl border bg-card text-card-foreground shadow-sm"
      data-testid="follower-onboarding-widget"
    >
      <header className="flex items-center justify-between gap-4 border-b p-4">
        <div>
          <h3 className="text-base font-semibold">Getting Started</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Complete these steps to start copy trading.
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold" data-testid="follower-onboarding-progress-value">
            {status.completedCount}/{status.totalCount}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {pct}% complete
          </div>
        </div>
      </header>
      <ol className="p-4 space-y-2">
        {status.steps.map((step) => (
          <li
            key={step.key}
            className="flex items-start gap-3"
            data-testid={`follower-onboarding-step-${step.key}`}
          >
            <span
              className={`mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-bold ${
                step.complete
                  ? 'bg-emerald-500 border-emerald-500 text-white'
                  : 'bg-background border-muted-foreground/50 text-muted-foreground'
              }`}
              aria-hidden
            >
              {step.complete ? '✓' : ''}
            </span>
            <div className="flex-1 flex items-center justify-between gap-3">
              <span className={step.complete ? 'text-sm' : 'text-sm text-muted-foreground'}>
                {step.label}
              </span>
              {!step.complete && onStepClick && (
                <button
                  type="button"
                  onClick={() => onStepClick(step.key)}
                  className="text-xs text-primary hover:underline"
                >
                  Complete →
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// FollowerDashboardHeader
// ---------------------------------------------------------------------------

export function FollowerDashboardHeader({
  summary,
}: {
  summary: FollowerDashboardSummaryDto;
}) {
  const brokerState: BrokerConnectionState =
    summary.connectedBrokers > 0
      ? 'CONNECTED'
      : summary.totalBrokers > 0
      ? 'DISCONNECTED'
      : 'DISCONNECTED';

  const displayName =
    summary.userName?.trim() || summary.userEmail || 'trader';

  return (
    <section
      className="rounded-xl border bg-card text-card-foreground shadow-sm"
      data-testid="follower-dashboard-header"
    >
      <div className="p-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Welcome
          </div>
          <h2 className="text-2xl font-bold mt-1" data-testid="follower-dashboard-welcome">
            {displayName}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Track brokers, subscriptions, and copy-trading readiness at a
            glance.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <BrokerConnectionBadge state={brokerState} />
        </div>
      </div>
      <div className="border-t grid grid-cols-2 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x">
        <Stat
          label="Broker Status"
          value={
            summary.totalBrokers === 0
              ? 'No brokers'
              : `${summary.connectedBrokers}/${summary.totalBrokers} connected`
          }
          testid="follower-dashboard-broker-status"
        />
        <Stat
          label="Active Strategies"
          value={String(summary.activeStrategies)}
          testid="follower-dashboard-active-strategies"
        />
        <Stat
          label="Active Subscriptions"
          value={String(summary.activeSubscriptions)}
          testid="follower-dashboard-active-subscriptions"
        />
        <Stat
          label="Last Sync"
          value={fmtTime(summary.lastSync)}
          testid="follower-dashboard-last-sync"
        />
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  testid,
}: {
  label: string;
  value: string;
  testid?: string;
}) {
  return (
    <div className="p-4">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold" data-testid={testid}>
        {value}
      </div>
    </div>
  );
}
