'use client';

import * as React from 'react';
import { Broker, BROKER_LABELS } from '@cts/shared';

/**
 * Sprint 6.2.4 — Shared "Add / Edit Broker" form.
 *
 * The single reusable broker onboarding form consumed by BOTH the Master
 * (admin) and Follower (web) portals. Field layout, spacing, validation and
 * conditional credential fields are defined here ONCE so the two portals are
 * pixel-identical. Only the surrounding dialog + submit/authentication action
 * differs per portal (that lives in each page). Pure presentation, controlled
 * via `value` + `onChange` — no app-local component dependencies so it renders
 * identically in either Next.js app.
 */

export interface BrokerAccountFormValue {
  broker: Broker;
  platform: string;
  nickname: string;
  clientId: string;
  apiKey?: string;
  apiSecret?: string;
  vendorCode?: string;
  password?: string;
  totpSecret?: string;
  staticIpPrimary?: string;
  staticIpSecondary?: string;
}

/** Which optional credential fields a broker needs (single source of truth). */
export function brokerFieldVisibility(broker: Broker): {
  vendorCode: boolean;
  password: boolean;
  totpSecret: boolean;
} {
  return {
    vendorCode: broker === Broker.SHOONYA,
    password: broker === Broker.SHOONYA || broker === Broker.ANGEL_ONE,
    totpSecret: broker === Broker.SHOONYA || broker === Broker.ANGEL_ONE,
  };
}

export interface BrokerAccountFormProps {
  value: BrokerAccountFormValue;
  onChange: (patch: Partial<BrokerAccountFormValue>) => void;
  /** When editing, the broker is fixed and secret fields may be left blank. */
  editing?: boolean;
  /** Prefix for data-testid attributes (keeps existing portal test ids). */
  testIdPrefix?: string;
}

const inputCls =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const labelCls = 'text-sm font-medium leading-none';

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

export function BrokerAccountForm({
  value,
  onChange,
  editing,
  testIdPrefix = 'broker-form',
}: BrokerAccountFormProps) {
  const vis = brokerFieldVisibility(value.broker);
  const secretPlaceholder = editing ? 'Leave blank to keep existing' : '';

  return (
    <div className="grid grid-cols-2 gap-3" data-testid={`${testIdPrefix}-fields`}>
      <Field label="Broker">
        <select
          className={inputCls}
          value={value.broker}
          onChange={(e) => onChange({ broker: e.target.value as Broker })}
          data-testid={`${testIdPrefix}-broker`}
        >
          {Object.values(Broker).map((b) => (
            <option key={b} value={b}>
              {BROKER_LABELS[b]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Platform">
        <input
          className={inputCls}
          value={value.platform}
          onChange={(e) => onChange({ platform: e.target.value })}
          required
          data-testid={`${testIdPrefix}-platform`}
        />
      </Field>

      <Field label="Nickname">
        <input
          className={inputCls}
          value={value.nickname}
          onChange={(e) => onChange({ nickname: e.target.value })}
          required
          data-testid={`${testIdPrefix}-nickname`}
        />
      </Field>

      <Field label="Client ID">
        <input
          className={inputCls}
          value={value.clientId}
          onChange={(e) => onChange({ clientId: e.target.value })}
          required
          data-testid={`${testIdPrefix}-client-id`}
        />
      </Field>

      <Field label="API Key">
        <input
          className={inputCls}
          type="password"
          value={value.apiKey ?? ''}
          placeholder={secretPlaceholder}
          onChange={(e) => onChange({ apiKey: e.target.value })}
          data-testid={`${testIdPrefix}-api-key`}
        />
      </Field>

      <Field label="API Secret">
        <input
          className={inputCls}
          type="password"
          value={value.apiSecret ?? ''}
          placeholder={secretPlaceholder}
          onChange={(e) => onChange({ apiSecret: e.target.value })}
          data-testid={`${testIdPrefix}-api-secret`}
        />
      </Field>

      {vis.vendorCode && (
        <Field label="Vendor Code">
          <input
            className={inputCls}
            value={value.vendorCode ?? ''}
            onChange={(e) => onChange({ vendorCode: e.target.value })}
            data-testid={`${testIdPrefix}-vendor-code`}
          />
        </Field>
      )}

      {vis.password && (
        <Field label="Password">
          <input
            className={inputCls}
            type="password"
            value={value.password ?? ''}
            placeholder={secretPlaceholder}
            onChange={(e) => onChange({ password: e.target.value })}
            data-testid={`${testIdPrefix}-password`}
          />
        </Field>
      )}

      {vis.totpSecret && (
        <Field label="TOTP Secret">
          <input
            className={inputCls}
            type="password"
            value={value.totpSecret ?? ''}
            placeholder={secretPlaceholder}
            onChange={(e) => onChange({ totpSecret: e.target.value })}
            data-testid={`${testIdPrefix}-totp-secret`}
          />
        </Field>
      )}

      <Field label="Static IP (primary)">
        <input
          className={inputCls}
          value={value.staticIpPrimary ?? ''}
          onChange={(e) => onChange({ staticIpPrimary: e.target.value })}
          data-testid={`${testIdPrefix}-static-ip-primary`}
        />
      </Field>

      <Field label="Static IP (secondary)">
        <input
          className={inputCls}
          value={value.staticIpSecondary ?? ''}
          onChange={(e) => onChange({ staticIpSecondary: e.target.value })}
          data-testid={`${testIdPrefix}-static-ip-secondary`}
        />
      </Field>
    </div>
  );
}
