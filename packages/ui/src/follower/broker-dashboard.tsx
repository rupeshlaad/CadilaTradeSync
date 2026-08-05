'use client';

import * as React from 'react';
import type {
  BrokerDashboardDto,
  BrokerDashboardSection,
} from '@cts/shared';

/**
 * Sprint 6.1.5 — SDK-driven operational broker dashboard, shared UI.
 *
 * Renders every section the broker adapter supports (profile, funds, holdings,
 * positions, orders, trades, portfolio) with capability-driven visibility and
 * per-section live refresh. All values come from BrokerService (the same
 * engine the Master Portal uses). Nothing is fabricated: unsupported sections
 * show "Not supported by broker"; missing profile fields show
 * "Not provided by broker".
 */

const NOT_SUPPORTED = 'Not supported by broker';
const NOT_PROVIDED = 'Not provided by broker';

type RefreshTarget = BrokerDashboardSection | 'all' | 'session' | null;

export interface BrokerDashboardPanelProps {
  dashboard: BrokerDashboardDto | null;
  loading?: boolean;
  refreshing?: RefreshTarget;
  onRefreshSection?: (section: BrokerDashboardSection) => void;
  onRefreshAll?: () => void;
  onRefreshSession?: () => void;
}

function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function numOrDash(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return String(v);
}

function profileText(v: string | null | undefined): string {
  return v && v.length > 0 ? v : NOT_PROVIDED;
}

function pnlClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  if (v > 0) return 'text-emerald-600 dark:text-emerald-400';
  if (v < 0) return 'text-destructive';
  return '';
}

function SectionShell({
  title,
  section,
  supported,
  refreshing,
  onRefresh,
  children,
}: {
  title: string;
  section: BrokerDashboardSection;
  supported: boolean;
  refreshing?: RefreshTarget;
  onRefresh?: (section: BrokerDashboardSection) => void;
  children: React.ReactNode;
}) {
  const busy = refreshing === section || refreshing === 'all';
  return (
    <section
      className="rounded-lg border"
      data-testid={`broker-dashboard-section-${section}`}
    >
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <h4 className="text-sm font-semibold">{title}</h4>
        {supported && onRefresh && (
          <button
            type="button"
            onClick={() => onRefresh(section)}
            disabled={busy}
            className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
            data-testid={`broker-dashboard-refresh-${section}`}
          >
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>
      <div className="p-4">
        {supported ? (
          children
        ) : (
          <p className="text-sm text-muted-foreground" data-testid={`broker-dashboard-${section}-unsupported`}>
            {NOT_SUPPORTED}
          </p>
        )}
      </div>
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left text-[11px] uppercase tracking-wide text-muted-foreground font-medium px-2 py-1.5">
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-2 py-1.5 ${className ?? ''}`}>{children}</td>;
}

export function BrokerDashboardPanel({
  dashboard,
  loading,
  refreshing,
  onRefreshSection,
  onRefreshAll,
  onRefreshSession,
}: BrokerDashboardPanelProps) {
  if (loading && !dashboard) {
    return (
      <div className="rounded-lg border p-6 text-sm text-muted-foreground" data-testid="broker-dashboard-loading">
        Loading live broker data…
      </div>
    );
  }
  if (!dashboard) return null;

  const { capabilities, features, profile, funds, holdings, positions, orders, trades, portfolio } =
    dashboard;
  const empty = (arr: unknown[] | null) => !arr || arr.length === 0;

  return (
    <div className="space-y-4" data-testid="broker-dashboard-panel">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onRefreshSession && (
          <button
            type="button"
            onClick={onRefreshSession}
            disabled={refreshing === 'session'}
            className="text-xs font-medium rounded-md border px-3 py-1.5 hover:bg-accent disabled:opacity-50"
            data-testid="broker-dashboard-refresh-session"
          >
            {refreshing === 'session' ? 'Refreshing…' : 'Refresh Session'}
          </button>
        )}
        {onRefreshAll && (
          <button
            type="button"
            onClick={onRefreshAll}
            disabled={refreshing === 'all'}
            className="text-xs font-medium rounded-md border px-3 py-1.5 hover:bg-accent disabled:opacity-50"
            data-testid="broker-dashboard-refresh-all"
          >
            {refreshing === 'all' ? 'Refreshing all…' : 'Refresh All'}
          </button>
        )}
      </div>

      {/* Profile */}
      <SectionShell
        title="Broker Profile"
        section="profile"
        supported={capabilities.profile}
        refreshing={refreshing}
        onRefresh={onRefreshSection}
      >
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          {[
            ['User Name', profile.userName],
            ['Email', profile.email],
            ['Mobile', profile.mobile],
            ['Account Type', profile.accountType],
            ['RMS Status', profile.rmsStatus],
            ['Profile Status', profile.profileStatus],
          ].map(([label, value]) => (
            <div key={label as string}>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
              <div>{profileText(value as string | null)}</div>
            </div>
          ))}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Exchanges</div>
            <div>{profile.exchanges && profile.exchanges.length > 0 ? profile.exchanges.join(', ') : NOT_PROVIDED}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Products</div>
            <div>{profile.products && profile.products.length > 0 ? profile.products.join(', ') : NOT_PROVIDED}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Segments</div>
            <div>{profile.segments && profile.segments.length > 0 ? profile.segments.join(', ') : NOT_PROVIDED}</div>
          </div>
        </div>
      </SectionShell>

      {/* Funds & Margin */}
      <SectionShell
        title="Funds & Margin"
        section="funds"
        supported={capabilities.funds}
        refreshing={refreshing}
        onRefresh={onRefreshSection}
      >
        {empty(funds) ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {funds!.map((f) => (
              <div key={f.segment} className="rounded-md border px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">{f.segment}</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-xs">
                  <span>Available Cash</span><span className="text-right">{money(f.availableCash)}</span>
                  <span>Available Margin</span><span className="text-right">{money(f.availableMargin)}</span>
                  <span>Used Margin</span><span className="text-right">{money(f.usedMargin)}</span>
                  <span>Opening Balance</span><span className="text-right">{money(f.openingBalance)}</span>
                  <span>Collateral</span><span className="text-right">{money(f.collateral)}</span>
                  <span>Net Balance</span><span className="text-right">{money(f.net)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionShell>

      {/* Portfolio */}
      {features.supportsPortfolio && (
        <SectionShell
          title="Portfolio"
          section="holdings"
          supported={features.supportsPortfolio}
          refreshing={refreshing}
          onRefresh={onRefreshSection}
        >
          {!portfolio ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Instruments</div>
                <div>{portfolio.instruments}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Value</div>
                <div className="font-mono">{money(portfolio.totalValue)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total P&L</div>
                <div className={`font-mono ${pnlClass(portfolio.totalPnl)}`}>{money(portfolio.totalPnl)}</div>
              </div>
            </div>
          )}
        </SectionShell>
      )}

      {/* Holdings */}
      <SectionShell
        title="Holdings"
        section="holdings"
        supported={capabilities.holdings}
        refreshing={refreshing}
        onRefresh={onRefreshSection}
      >
        {empty(holdings) ? (
          <p className="text-sm text-muted-foreground">No holdings.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <Th>Symbol</Th><Th>Exchange</Th><Th>Qty</Th><Th>Avg Price</Th><Th>LTP</Th><Th>Value</Th><Th>P&L</Th>
                </tr>
              </thead>
              <tbody>
                {holdings!.map((h, i) => (
                  <tr key={`${h.symbol}-${i}`} className="border-b last:border-0">
                    <Td className="font-medium">{h.symbol}</Td>
                    <Td>{h.exchange ?? '—'}</Td>
                    <Td>{numOrDash(h.quantity)}</Td>
                    <Td className="font-mono">{money(h.averagePrice)}</Td>
                    <Td className="font-mono">{money(h.ltp)}</Td>
                    <Td className="font-mono">{money(h.currentValue)}</Td>
                    <Td className={`font-mono ${pnlClass(h.pnl)}`}>{money(h.pnl)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionShell>

      {/* Positions */}
      <SectionShell
        title="Positions"
        section="positions"
        supported={capabilities.positions}
        refreshing={refreshing}
        onRefresh={onRefreshSection}
      >
        {empty(positions) ? (
          <p className="text-sm text-muted-foreground">No open positions.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <Th>Symbol</Th><Th>Exchange</Th><Th>Product</Th><Th>Qty</Th><Th>Avg Price</Th><Th>LTP</Th><Th>P&L</Th>
                </tr>
              </thead>
              <tbody>
                {positions!.map((p, i) => (
                  <tr key={`${p.symbol}-${i}`} className="border-b last:border-0">
                    <Td className="font-medium">{p.symbol}</Td>
                    <Td>{p.exchange ?? '—'}</Td>
                    <Td>{p.product ?? '—'}</Td>
                    <Td>{numOrDash(p.quantity)}</Td>
                    <Td className="font-mono">{money(p.averagePrice)}</Td>
                    <Td className="font-mono">{money(p.ltp)}</Td>
                    <Td className={`font-mono ${pnlClass(p.pnl)}`}>{money(p.pnl)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionShell>

      {/* Orders */}
      <SectionShell
        title="Order Book"
        section="orders"
        supported={capabilities.orders}
        refreshing={refreshing}
        onRefresh={onRefreshSection}
      >
        {empty(orders) ? (
          <p className="text-sm text-muted-foreground">No orders today.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <Th>Order ID</Th><Th>Symbol</Th><Th>Side</Th><Th>Qty</Th><Th>Price</Th><Th>Type</Th><Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {orders!.map((o, i) => (
                  <tr key={`${o.orderId}-${i}`} className="border-b last:border-0">
                    <Td className="font-mono">{o.orderId}</Td>
                    <Td className="font-medium">{o.symbol}</Td>
                    <Td>{o.side ?? '—'}</Td>
                    <Td>{numOrDash(o.quantity)}</Td>
                    <Td className="font-mono">{money(o.price)}</Td>
                    <Td>{o.orderType ?? '—'}</Td>
                    <Td>{o.status ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionShell>

      {/* Trades */}
      <SectionShell
        title="Today's Trades"
        section="trades"
        supported={capabilities.trades}
        refreshing={refreshing}
        onRefresh={onRefreshSection}
      >
        {empty(trades) ? (
          <p className="text-sm text-muted-foreground">No executed trades today.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <Th>Trade ID</Th><Th>Symbol</Th><Th>Side</Th><Th>Qty</Th><Th>Price</Th><Th>Time</Th>
                </tr>
              </thead>
              <tbody>
                {trades!.map((t, i) => (
                  <tr key={`${t.tradeId}-${i}`} className="border-b last:border-0">
                    <Td className="font-mono">{t.tradeId}</Td>
                    <Td className="font-medium">{t.symbol}</Td>
                    <Td>{t.side ?? '—'}</Td>
                    <Td>{numOrDash(t.quantity)}</Td>
                    <Td className="font-mono">{money(t.price)}</Td>
                    <Td>{t.time ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionShell>
    </div>
  );
}
