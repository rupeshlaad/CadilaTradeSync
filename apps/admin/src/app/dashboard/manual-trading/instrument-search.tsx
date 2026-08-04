'use client';

/**
 * Sprint 5.4.1 — Broker-aware instrument autocomplete.
 *
 * Renders the Symbol picker for the Manual Trading order form.
 * Behaviour:
 *   • Debounced remote search (~300 ms) via
 *     `GET /admin/instruments/manual-search`, broker-scoped.
 *   • Requires min 2 characters before firing a query.
 *   • Keyboard navigation: ↑ / ↓ / Enter / Esc.
 *   • Only broker-verified selections satisfy the "instrument
 *     chosen" invariant that the page uses to gate Place Order.
 *   • Displays broker symbol read-only after selection so the
 *     operator cannot mistype it.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { Broker } from '@cts/shared';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, XCircle } from 'lucide-react';
import { api, type ManualInstrumentSearchRow } from '@/lib/api';

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 300;
const DEFAULT_LIMIT = 20;

export interface InstrumentSearchProps {
  /** Broker whose symbol universe should be searched (from Master Account). */
  broker: Broker | null;
  /** Currently selected instrument, or null when the picker is empty. */
  selected: ManualInstrumentSearchRow | null;
  /** Fired when the operator picks a row from the dropdown. */
  onSelect: (row: ManualInstrumentSearchRow) => void;
  /** Fired when the operator clears the picker. */
  onClear: () => void;
  /** Disabled state (e.g. no master account chosen yet). */
  disabled?: boolean;
}

export function InstrumentSearch({
  broker,
  selected,
  onSelect,
  onClear,
  disabled,
}: InstrumentSearchProps) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ManualInstrumentSearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const listboxId = 'instrument-search-listbox';

  const trimmed = query.trim();
  const shouldSearch = trimmed.length >= MIN_QUERY_LEN && !!broker && !selected;

  // ---- Debounced remote search -------------------------------------------
  useEffect(() => {
    if (!shouldSearch) {
      if (abortRef.current) abortRef.current.abort();
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }

    const mySeq = ++requestSeqRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setLoading(true);

    const timer = window.setTimeout(async () => {
      try {
        const res = await api.admin.instruments.manualSearch(broker!, trimmed, {
          limit: DEFAULT_LIMIT,
          signal: controller.signal,
        });
        if (mySeq !== requestSeqRef.current) return;
        setItems(res.items);
        setHighlight(0);
        setError(res.items.length === 0
          ? 'Instrument not found for selected broker.'
          : null);
      } catch (err: any) {
        if (controller.signal.aborted) return;
        if (mySeq !== requestSeqRef.current) return;
        setItems([]);
        setError(err?.message ?? 'Search failed');
      } finally {
        if (mySeq === requestSeqRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [trimmed, broker, shouldSearch]);

  // ---- Close on outside click --------------------------------------------
  useEffect(() => {
    if (!open) return;
    const handler = (evt: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(evt.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const helper = useMemo(() => {
    if (disabled) return 'Select a master account first to enable the symbol search.';
    if (!broker) return 'Symbol search follows the master account\u2019s broker.';
    if (selected) return `${selected.exchange} · ${selected.segment} · lot ${selected.lotSize}${selected.tickSize != null ? ` · tick ${selected.tickSize}` : ''}`;
    if (trimmed.length === 0) return 'Start typing at least two characters to search the broker\u2019s instrument universe.';
    if (trimmed.length < MIN_QUERY_LEN) return `Type ${MIN_QUERY_LEN - trimmed.length} more character to search.`;
    return 'Use \u2191 / \u2193 to navigate, Enter to select, Esc to close.';
  }, [broker, disabled, selected, trimmed]);

  const handleSelect = useCallback(
    (row: ManualInstrumentSearchRow) => {
      onSelect(row);
      setQuery('');
      setItems([]);
      setOpen(false);
      setError(null);
    },
    [onSelect],
  );

  const handleClear = useCallback(() => {
    onClear();
    setQuery('');
    setItems([]);
    setError(null);
    setHighlight(0);
    // Return focus to the input so the operator can immediately search again.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [onClear]);

  const onKeyDown = useCallback(
    (evt: KeyboardEvent<HTMLInputElement>) => {
      if (!open || items.length === 0) {
        if (evt.key === 'Escape') setOpen(false);
        return;
      }
      if (evt.key === 'ArrowDown') {
        evt.preventDefault();
        setHighlight((h) => (h + 1) % items.length);
      } else if (evt.key === 'ArrowUp') {
        evt.preventDefault();
        setHighlight((h) => (h - 1 + items.length) % items.length);
      } else if (evt.key === 'Enter') {
        evt.preventDefault();
        const row = items[highlight];
        if (row) handleSelect(row);
      } else if (evt.key === 'Escape') {
        evt.preventDefault();
        setOpen(false);
      }
    },
    [handleSelect, highlight, items, open],
  );

  // -------------------------------------------------------------------------
  // Selected-state render — hides the searchable input entirely so the
  // operator cannot manually type or edit the broker symbol.
  // -------------------------------------------------------------------------
  if (selected) {
    return (
      <div className="space-y-2" data-testid="instrument-search">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Symbol
        </Label>
        <div
          className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2"
          data-testid="instrument-search-selected"
        >
          <div className="min-w-0">
            <div
              className="font-mono text-sm truncate"
              data-testid="instrument-search-selected-symbol"
            >
              {selected.brokerSymbol}
            </div>
            <div
              className="text-[11px] text-muted-foreground truncate"
              data-testid="instrument-search-selected-display"
            >
              {selected.displayName}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={disabled}
            data-testid="instrument-search-clear"
          >
            <XCircle className="h-4 w-4 mr-1" /> Change
          </Button>
        </div>
        <div className="text-[11px] text-muted-foreground" data-testid="instrument-search-helper">
          {helper}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Empty-state render — searchable typeahead with dropdown.
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-1" ref={containerRef} data-testid="instrument-search">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        Symbol
      </Label>
      <div className="relative">
        <Input
          ref={inputRef}
          placeholder={broker ? `Search ${broker} instruments…` : 'Select master account first'}
          value={query}
          onChange={(evt) => {
            setQuery(evt.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          disabled={disabled || !broker}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={
            open && items[highlight] ? `${listboxId}-option-${items[highlight].instrumentId}` : undefined
          }
          data-testid="instrument-search-input"
        />
        {loading && (
          <Loader2
            className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground"
            data-testid="instrument-search-loading"
          />
        )}

        {open && shouldSearch && (
          <div
            className="absolute z-20 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-lg max-h-80 overflow-y-auto"
            role="listbox"
            id={listboxId}
            data-testid="instrument-search-listbox"
          >
            {items.length === 0 && !loading && (
              <div
                className="px-3 py-2 text-sm text-muted-foreground"
                data-testid="instrument-search-empty"
              >
                No instruments match &quot;{trimmed}&quot; for {broker}.
              </div>
            )}
            {items.map((row, idx) => {
              const active = idx === highlight;
              return (
                <button
                  type="button"
                  key={`${row.instrumentId}:${row.brokerSymbol}`}
                  id={`${listboxId}-option-${row.instrumentId}`}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setHighlight(idx)}
                  onMouseDown={(evt) => {
                    // Prevent input blur before onClick fires.
                    evt.preventDefault();
                  }}
                  onClick={() => handleSelect(row)}
                  className={`w-full text-left px-3 py-2 border-b last:border-b-0 text-sm transition-colors ${
                    active ? 'bg-accent text-accent-foreground' : ''
                  }`}
                  data-testid={`instrument-search-option-${row.brokerSymbol}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-sm truncate">
                        {row.brokerSymbol}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {row.displayName}
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground shrink-0">
                      {row.exchange} · {row.segment} · lot {row.lotSize}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div
        className={`text-[11px] ${error && !loading && items.length === 0 ? 'text-destructive' : 'text-muted-foreground'}`}
        data-testid="instrument-search-helper"
      >
        {error && !loading && items.length === 0 && trimmed.length >= MIN_QUERY_LEN
          ? error
          : helper}
      </div>
    </div>
  );
}
