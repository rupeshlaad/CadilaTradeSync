'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type StrategyExecutionStatusResponse,
  type ExecutionState,
  type StrategyExecutionValidationCheck,
  type TradeEventRecord,
  type TradeEventPipelineSummary,
  type TradeEventStatus,
} from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { BROKER_LABELS, type StrategyDto } from '@cts/shared';
import {
  Play,
  Pause,
  Square,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  ShieldCheck,
  Activity,
} from 'lucide-react';

type AdminStrategy = StrategyDto & {
  tradingAccount?: { nickname: string; broker: string; user?: { email: string } };
};

const STATE_VARIANTS: Record<ExecutionState, 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  DRAFT: 'outline',
  READY: 'secondary',
  RUNNING: 'success',
  PAUSED: 'warning',
  STOPPED: 'outline',
  ERROR: 'destructive',
};

function formatDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

const CHECK_LABELS: Record<StrategyExecutionValidationCheck['key'], string> = {
  strategy_exists: 'Strategy exists',
  strategy_active: 'Strategy is active',
  master_account_exists: 'Master account present',
  broker_session_exists: 'Broker session exists',
  broker_session_healthy: 'Broker session healthy',
  instrument_mappings_valid: 'Instrument mappings loaded',
};

export default function StrategyExecutionPage() {
  const [strategies, setStrategies] = useState<AdminStrategy[]>([]);
  const [strategiesLoading, setStrategiesLoading] = useState(true);
  const [strategiesError, setStrategiesError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string>('');
  const selected = useMemo(
    () => strategies.find((s) => s.id === selectedId) ?? null,
    [strategies, selectedId],
  );

  const [status, setStatus] = useState<StrategyExecutionStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [busy, setBusy] = useState<
    'validate' | 'start' | 'pause' | 'resume' | 'stop' | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<
    StrategyExecutionValidationCheck[] | null
  >(null);

  // Load strategies once so the operator can pick one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStrategiesLoading(true);
      setStrategiesError(null);
      try {
        const rows = await api.admin.listStrategies();
        if (cancelled) return;
        setStrategies(rows as AdminStrategy[]);
        if (rows.length > 0) setSelectedId(rows[0].id);
      } catch (e: any) {
        if (!cancelled) setStrategiesError(e?.message ?? 'Failed to load strategies');
      } finally {
        if (!cancelled) setStrategiesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadStatus = useCallback(
    async (id: string) => {
      setStatusLoading(true);
      setStatusError(null);
      setActionError(null);
      setValidationErrors(null);
      try {
        const s = await api.admin.strategyExecution.status(id);
        setStatus(s);
      } catch (e: any) {
        setStatusError(e?.message ?? 'Failed to load execution status');
        setStatus(null);
      } finally {
        setStatusLoading(false);
      }
    },
    [],
  );

  // Refresh status when a strategy is selected.
  useEffect(() => {
    if (!selectedId) {
      setStatus(null);
      return;
    }
    loadStatus(selectedId);
  }, [selectedId, loadStatus]);

  const runAction = useCallback(
    async (
      key: 'validate' | 'start' | 'pause' | 'resume' | 'stop',
      fn: () => Promise<any>,
    ) => {
      if (!selectedId) return;
      setBusy(key);
      setActionError(null);
      setValidationErrors(null);
      try {
        const res = await fn();
        // `validate` returns a ValidationResult; other actions return a
        // StrategyExecutionStatusResponse. Refresh the status either way
        // so the UI always shows the authoritative server state.
        if (key === 'validate') {
          if (res && Array.isArray(res.errors) && res.errors.length > 0) {
            setValidationErrors(res.errors);
          }
        }
        await loadStatus(selectedId);
      } catch (e: any) {
        const body = (e as any)?.body;
        if (body && Array.isArray(body.errors) && body.errors.length > 0) {
          setValidationErrors(body.errors);
          setActionError(body.message ?? e.message ?? 'Action failed');
        } else {
          setActionError(e?.message ?? 'Action failed');
        }
        // Always refresh status so the UI reflects the server's state
        // machine (e.g. ERROR after a failed start).
        await loadStatus(selectedId);
      } finally {
        setBusy(null);
      }
    },
    [selectedId, loadStatus],
  );

  const state: ExecutionState = status?.state ?? 'DRAFT';
  const ctx = status?.context ?? null;
  const lastValidation = status?.lastValidation ?? null;

  // Determine which controls are enabled based on the current state so
  // the UI mirrors the backend state machine (invalid transitions still
  // get a 409 from the server, but pre-disabling avoids surprises).
  const canValidate = !!selectedId && !busy;
  const canStart =
    !!selectedId && !busy && (state === 'READY' || state === 'DRAFT' || state === 'STOPPED' || state === 'ERROR');
  const canPause = !!selectedId && !busy && state === 'RUNNING';
  const canResume = !!selectedId && !busy && state === 'PAUSED';
  const canStop =
    !!selectedId && !busy && (state === 'RUNNING' || state === 'PAUSED' || state === 'READY' || state === 'ERROR');

  return (
    <div className="space-y-6" data-testid="strategy-execution-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">Strategy Execution</h2>
          <p className="text-muted-foreground">
            Phase 1 — validate, start, pause, resume and stop a strategy. Execution state is in-memory:
            no orders are placed and no background scheduler is running.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Strategy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="strategy-select">Select a strategy</Label>
              {strategiesLoading ? (
                <div className="h-10 rounded-md bg-muted/60 animate-pulse" aria-hidden />
              ) : strategiesError ? (
                <div
                  className="text-sm text-destructive"
                  role="alert"
                  data-testid="strategies-load-error"
                >
                  {strategiesError}
                </div>
              ) : strategies.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No strategies exist yet. Create one in the Strategies page first.
                </div>
              ) : (
                <Select
                  id="strategy-select"
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  data-testid="strategy-select"
                >
                  {strategies.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.strategyName}
                      {s.tradingAccount
                        ? ` — ${s.tradingAccount.nickname} (${BROKER_LABELS[s.tradingAccount.broker as keyof typeof BROKER_LABELS] ?? s.tradingAccount.broker})`
                        : ''}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <Button
              variant="outline"
              onClick={() => selectedId && loadStatus(selectedId)}
              disabled={!selectedId || statusLoading}
              data-testid="refresh-status-btn"
            >
              {statusLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Refresh status
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Execution status</CardTitle>
          <Badge
            variant={STATE_VARIANTS[state]}
            data-testid="execution-state-badge"
          >
            {state}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {statusError && (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
              data-testid="status-error"
            >
              {statusError}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-4 text-sm">
            <StatusField
              label="Strategy"
              value={selected?.strategyName ?? '—'}
            />
            <StatusField
              label="Master account"
              value={
                selected?.tradingAccount
                  ? `${selected.tradingAccount.nickname}`
                  : ctx?.masterAccountId ?? '—'
              }
            />
            <StatusField
              label="Broker"
              value={
                ctx?.broker
                  ? BROKER_LABELS[ctx.broker as keyof typeof BROKER_LABELS] ?? ctx.broker
                  : selected?.tradingAccount?.broker
                  ? BROKER_LABELS[selected.tradingAccount.broker as keyof typeof BROKER_LABELS] ?? selected.tradingAccount.broker
                  : '—'
              }
            />
            <StatusField
              label="Started at"
              value={formatDateTime(ctx?.startedAt)}
              testId="status-started-at"
            />
            <StatusField
              label="Last heartbeat"
              value={formatDateTime(ctx?.lastHeartbeat)}
              testId="status-last-heartbeat"
            />
            <StatusField
              label="Last validation"
              value={formatDateTime(lastValidation?.validatedAt)}
              testId="status-last-validation"
            />
            <StatusField
              label="Validation result"
              value={
                lastValidation
                  ? lastValidation.ok
                    ? 'PASS'
                    : `FAIL (${lastValidation.errors.length} issue${lastValidation.errors.length === 1 ? '' : 's'})`
                  : 'Not run'
              }
              emphasise={
                lastValidation
                  ? lastValidation.ok
                    ? 'success'
                    : 'destructive'
                  : undefined
              }
              testId="status-validation-result"
            />
            <StatusField
              label="Last error"
              value={ctx?.lastError ?? '—'}
              emphasise={ctx?.lastError ? 'destructive' : undefined}
            />
          </div>

          <div className="flex flex-wrap gap-2 pt-2 border-t">
            <Button
              variant="outline"
              onClick={() =>
                runAction('validate', () =>
                  api.admin.strategyExecution.validate(selectedId),
                )
              }
              disabled={!canValidate}
              data-testid="validate-btn"
            >
              {busy === 'validate' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Validate
            </Button>
            <Button
              onClick={() =>
                runAction('start', () =>
                  api.admin.strategyExecution.start(selectedId),
                )
              }
              disabled={!canStart}
              data-testid="start-btn"
            >
              {busy === 'start' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Start
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                runAction('pause', () =>
                  api.admin.strategyExecution.pause(selectedId),
                )
              }
              disabled={!canPause}
              data-testid="pause-btn"
            >
              {busy === 'pause' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Pause className="h-4 w-4" />
              )}
              Pause
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                runAction('resume', () =>
                  api.admin.strategyExecution.resume(selectedId),
                )
              }
              disabled={!canResume}
              data-testid="resume-btn"
            >
              {busy === 'resume' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Resume
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                runAction('stop', () =>
                  api.admin.strategyExecution.stop(selectedId),
                )
              }
              disabled={!canStop}
              data-testid="stop-btn"
            >
              {busy === 'stop' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Square className="h-4 w-4" />
              )}
              Stop
            </Button>
          </div>

          {actionError && (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
              data-testid="action-error"
            >
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" />
                {actionError}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Validation checks</CardTitle>
        </CardHeader>
        <CardContent>
          {!lastValidation ? (
            <div className="text-sm text-muted-foreground" data-testid="validation-empty">
              Run <span className="font-medium">Validate</span> to see pre-flight checks.
            </div>
          ) : (
            <div className="space-y-2" data-testid="validation-checks">
              {lastValidation.checks.map((c) => (
                <div
                  key={c.key}
                  className="flex items-start gap-3 rounded-md border p-3 text-sm"
                  data-testid={`validation-check-${c.key}`}
                >
                  {c.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">
                      {CHECK_LABELS[c.key] ?? c.key}
                    </div>
                    <div className="text-xs text-muted-foreground break-words">
                      {c.message}
                    </div>
                  </div>
                  <Badge variant={c.ok ? 'success' : 'destructive'}>
                    {c.ok ? 'OK' : 'FAIL'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
          {validationErrors && validationErrors.length > 0 && lastValidation === null && (
            <div className="mt-3 text-sm text-destructive" data-testid="validation-fallback-errors">
              {validationErrors.map((c) => (
                <div key={c.key}>• {c.message}</div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <TradeEventPipelinePanel />
    </div>
  );
}

function StatusField({
  label,
  value,
  emphasise,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  emphasise?: 'success' | 'destructive';
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div
        className={`text-sm ${
          emphasise === 'success'
            ? 'text-emerald-600 dark:text-emerald-400 font-medium'
            : emphasise === 'destructive'
            ? 'text-destructive font-medium'
            : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}

const TRADE_EVENT_STATUS_VARIANTS: Record<
  TradeEventStatus,
  'secondary' | 'success' | 'warning' | 'destructive' | 'outline'
> = {
  RECEIVED: 'outline',
  NORMALIZED: 'secondary',
  VALIDATED: 'success',
  READY: 'success',
  DUPLICATE: 'warning',
  REJECTED: 'destructive',
};

function TradeEventPipelinePanel() {
  const [summary, setSummary] = useState<TradeEventPipelineSummary | null>(null);
  const [records, setRecords] = useState<TradeEventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sum, rec] = await Promise.all([
        api.admin.tradeEvents.summary(),
        api.admin.tradeEvents.recent(20),
      ]);
      setSummary(sum);
      setRecords(rec.items);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load trade event pipeline');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const latest = summary?.latest ?? records[0] ?? null;

  return (
    <Card data-testid="trade-event-pipeline-panel">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Trade Event Pipeline
        </CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading}
          data-testid="trade-event-refresh-btn"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">
          Read-only view of the intake pipeline. Trade generation happens on the master broker;
          this panel shows how each executed master trade was normalized and validated before
          the copy-trading pipeline runs.
        </p>

        {error && (
          <div
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            role="alert"
            data-testid="trade-event-error"
          >
            {error}
          </div>
        )}

        {/* Counter strip */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3" data-testid="trade-event-counts">
          {(
            [
              'VALIDATED',
              'NORMALIZED',
              'DUPLICATE',
              'REJECTED',
              'RECEIVED',
            ] as TradeEventStatus[]
          ).map((s) => (
            <div
              key={s}
              className="rounded-md border p-3 space-y-1"
              data-testid={`trade-event-count-${s.toLowerCase()}`}
            >
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {s}
              </div>
              <div className="text-xl font-semibold">
                {summary?.counts?.[s] ?? 0}
              </div>
            </div>
          ))}
        </div>

        {/* Last received event */}
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Last received trade event
          </div>
          {!latest ? (
            <div
              className="text-sm text-muted-foreground border rounded-md p-4"
              data-testid="trade-event-empty"
            >
              No trade events have entered the intake pipeline yet.
            </div>
          ) : (
            <div
              className="rounded-md border p-4 space-y-3"
              data-testid="trade-event-latest"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={TRADE_EVENT_STATUS_VARIANTS[latest.event.status]}>
                    {latest.event.status}
                  </Badge>
                  <Badge variant="secondary">{latest.event.source}</Badge>
                  <Badge variant="secondary">{latest.event.broker}</Badge>
                  <Badge variant={latest.event.side === 'BUY' ? 'success' : 'warning'}>
                    {latest.event.side}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatDateTime(latest.event.receivedAt)}
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <StatusField label="Symbol" value={latest.event.brokerSymbol} />
                <StatusField
                  label="Quantity"
                  value={latest.event.quantity.toLocaleString()}
                />
                <StatusField
                  label="Price"
                  value={latest.event.price != null ? latest.event.price.toString() : '—'}
                />
                <StatusField
                  label="Broker order id"
                  value={
                    <span className="font-mono text-xs break-all">
                      {latest.event.brokerOrderId || '—'}
                    </span>
                  }
                />
                <StatusField
                  label="Validation result"
                  value={
                    latest.validation
                      ? latest.validation.ok
                        ? 'PASS'
                        : `FAIL (${latest.validation.errors.length})`
                      : latest.event.status === 'DUPLICATE'
                      ? 'Skipped (duplicate)'
                      : 'Not validated'
                  }
                  emphasise={
                    latest.validation?.ok === true
                      ? 'success'
                      : latest.validation?.ok === false
                      ? 'destructive'
                      : undefined
                  }
                />
                <StatusField
                  label="Contract key"
                  value={
                    <span className="font-mono text-xs break-all">
                      {latest.event.contractKey ?? '—'}
                    </span>
                  }
                />
                <StatusField
                  label="Strategy"
                  value={
                    <span className="font-mono text-xs break-all">
                      {latest.event.strategyId ?? '—'}
                    </span>
                  }
                />
                <StatusField
                  label="Broker timestamp"
                  value={formatDateTime(latest.event.brokerTimestamp)}
                />
              </div>
              {latest.rejectionReason && (
                <div
                  className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
                  data-testid="trade-event-latest-reason"
                >
                  {latest.rejectionReason}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Recent events table */}
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Recent events ({records.length})
          </div>
          {records.length === 0 ? (
            <div className="text-sm text-muted-foreground border rounded-md p-4">
              No history yet.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm" data-testid="trade-event-table">
                <thead>
                  <tr className="text-left text-muted-foreground border-b bg-muted/40">
                    <th className="py-2 px-3">Received</th>
                    <th className="py-2 px-3">Source</th>
                    <th className="py-2 px-3">Broker</th>
                    <th className="py-2 px-3">Symbol</th>
                    <th className="py-2 px-3">Side</th>
                    <th className="py-2 px-3">Qty</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3">Validation</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr
                      key={r.event.id}
                      className="border-b last:border-none"
                      data-testid={`trade-event-row-${r.event.id}`}
                    >
                      <td className="py-2 px-3 text-xs text-muted-foreground whitespace-nowrap">
                        {formatDateTime(r.event.receivedAt)}
                      </td>
                      <td className="py-2 px-3 text-xs">
                        <Badge variant="secondary">{r.event.source}</Badge>
                      </td>
                      <td className="py-2 px-3 text-xs">
                        <Badge variant="secondary">{r.event.broker}</Badge>
                      </td>
                      <td className="py-2 px-3 font-mono text-xs">
                        {r.event.brokerSymbol || '—'}
                      </td>
                      <td className="py-2 px-3 text-xs">
                        {r.event.side ? (
                          <Badge
                            variant={r.event.side === 'BUY' ? 'success' : 'warning'}
                          >
                            {r.event.side}
                          </Badge>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 px-3 font-mono text-xs">
                        {r.event.quantity ? r.event.quantity.toLocaleString() : '—'}
                      </td>
                      <td className="py-2 px-3 text-xs">
                        <Badge
                          variant={TRADE_EVENT_STATUS_VARIANTS[r.event.status]}
                        >
                          {r.event.status}
                        </Badge>
                      </td>
                      <td className="py-2 px-3 text-xs">
                        {r.validation ? (
                          <Badge
                            variant={r.validation.ok ? 'success' : 'destructive'}
                          >
                            {r.validation.ok
                              ? 'PASS'
                              : `FAIL (${r.validation.errors.length})`}
                          </Badge>
                        ) : r.event.status === 'DUPLICATE' ? (
                          <span className="text-muted-foreground">skipped</span>
                        ) : r.rejectionReason ? (
                          <span className="text-destructive">
                            {r.rejectionReason.length > 60
                              ? r.rejectionReason.slice(0, 60) + '…'
                              : r.rejectionReason}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
