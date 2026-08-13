/**
 * Broker execution-response normalization. Converts each broker's native
 * place-order response (or a thrown adapter error) into a broker-neutral
 * partial {@link StandardExecutionResult}, so CopyTradingService never sees a
 * broker-specific payload. Success detection mirrors the exact logic the copy
 * engine used previously (Fyers `s==='ok'`, Upstox `data.order_id`, ICICI
 * `order_id`, Zerodha string / `order_id`) — no behaviour change for the
 * brokers that already worked; Zerodha is now included.
 *
 * All failure classification flows through {@link classifyBrokerMessage} so
 * there are no magic strings scattered across the codebase.
 */
import { Broker } from '@prisma/client';

import {
  ExecutionResultCategory,
  isRetryable,
} from '../../copy-trading/execution-result-category';

export interface NormalizedExecutionOutcome {
  success: boolean;
  category: ExecutionResultCategory;
  retryable: boolean;
  brokerOrderId: string | null;
  exchangeOrderId: string | null;
  httpStatus: number | null;
  brokerStatus: string | null;
  brokerMessage: string | null;
  failureReason: string | null;
  rawResponse: unknown | null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number') return String(v);
  return null;
}

function firstMessage(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Central broker-error classifier. Specific causes are checked before generic
 * ones (a token "invalid" must beat the generic validation branch). Returns
 * REJECTED_BY_BROKER for a plain rejection, UNKNOWN_BROKER_ERROR as the floor.
 */
export function classifyBrokerMessage(
  message: string | null | undefined,
): ExecutionResultCategory {
  const raw = String(message ?? '').toLowerCase();
  if (!raw) return ExecutionResultCategory.UNKNOWN_BROKER_ERROR;

  if (
    /access[_ ]?token|api[_ ]?key|token (is )?(invalid|expired)|(invalid|expired) .*token|session (expired|invalid)/.test(
      raw,
    )
  ) {
    return ExecutionResultCategory.TOKEN_EXPIRED;
  }
  if (/unauthor|forbidden|not authenticated|authentication|401|403/.test(raw)) {
    return ExecutionResultCategory.AUTHENTICATION_FAILED;
  }
  if (/insufficient (funds|balance|margin)|not enough (funds|balance|margin)|margin shortfall|available margin/.test(raw)) {
    return ExecutionResultCategory.INSUFFICIENT_FUNDS;
  }
  if (/\brms\b|risk management|blocked by rms|rms rejection/.test(raw)) {
    return ExecutionResultCategory.RMS_REJECTION;
  }
  if (/\bamo\b|after market order|after-market/.test(raw)) {
    return ExecutionResultCategory.AMO_NOT_SUPPORTED;
  }
  if (/product[- ]?type|product .*(not allowed|not permitted)|using .* product/.test(raw)) {
    return ExecutionResultCategory.PRODUCT_NOT_ALLOWED;
  }
  if (/rate limit|too many requests|429/.test(raw)) {
    return ExecutionResultCategory.BROKER_RATE_LIMIT;
  }
  if (/timeout|timed out|etimedout/.test(raw)) {
    return ExecutionResultCategory.BROKER_TIMEOUT;
  }
  if (/econnrefused|enotfound|econnreset|eai_again|network|socket hang up/.test(raw)) {
    return ExecutionResultCategory.NETWORK_FAILURE;
  }
  if (/service unavailable|502|503|maintenance|temporarily unavailable/.test(raw)) {
    return ExecutionResultCategory.BROKER_UNAVAILABLE;
  }
  if (/mandatory|required field|validation|invalid|malformed/.test(raw)) {
    return ExecutionResultCategory.BROKER_VALIDATION;
  }
  if (/reject/.test(raw)) {
    return ExecutionResultCategory.REJECTED_BY_BROKER;
  }
  return ExecutionResultCategory.UNKNOWN_BROKER_ERROR;
}

function fail(
  category: ExecutionResultCategory,
  message: string | null,
  raw: unknown,
  extra: Partial<NormalizedExecutionOutcome> = {},
): NormalizedExecutionOutcome {
  return {
    success: false,
    category,
    retryable: isRetryable(category),
    brokerOrderId: extra.brokerOrderId ?? null,
    exchangeOrderId: extra.exchangeOrderId ?? null,
    httpStatus: extra.httpStatus ?? null,
    brokerStatus: extra.brokerStatus ?? null,
    brokerMessage: message,
    failureReason: message,
    rawResponse: raw,
  };
}

function succeed(
  brokerOrderId: string | null,
  raw: unknown,
  extra: Partial<NormalizedExecutionOutcome> = {},
): NormalizedExecutionOutcome {
  return {
    success: true,
    category: ExecutionResultCategory.SUCCESS,
    retryable: false,
    brokerOrderId,
    exchangeOrderId: extra.exchangeOrderId ?? null,
    httpStatus: extra.httpStatus ?? null,
    brokerStatus: extra.brokerStatus ?? null,
    brokerMessage: extra.brokerMessage ?? null,
    failureReason: null,
    rawResponse: raw,
  };
}

/** Normalize a successful (non-throwing) broker place-order response. */
export function normalizeExecutionResponse(
  broker: Broker,
  raw: any,
): NormalizedExecutionOutcome {
  switch (broker) {
    case Broker.FYERS: {
      const ok = raw?.s === 'ok';
      const message = firstMessage(raw?.message, typeof raw === 'string' ? raw : null);
      if (ok) {
        return succeed(str(raw?.id), raw, {
          brokerStatus: str(raw?.s),
          brokerMessage: message,
        });
      }
      return fail(classifyBrokerMessage(message), message ?? 'Fyers returned non-ok response', raw, {
        brokerStatus: str(raw?.s),
        httpStatus: typeof raw?.code === 'number' ? raw.code : null,
      });
    }

    case Broker.UPSTOX: {
      const data = raw?.data ?? {};
      const orderId =
        str(data?.order_id) ??
        (Array.isArray(data?.order_ids) ? str(data.order_ids[0]) : null);
      const message = firstMessage(
        raw?.message,
        Array.isArray(raw?.errors) ? raw.errors?.[0]?.message : null,
        typeof raw === 'string' ? raw : null,
      );
      if (orderId) {
        return succeed(orderId, raw, { brokerStatus: str(raw?.status), brokerMessage: message });
      }
      return fail(classifyBrokerMessage(message), message ?? 'Upstox did not return an order id', raw, {
        brokerStatus: str(raw?.status),
      });
    }

    case Broker.ICICI_DIRECT: {
      const success = raw?.Success ?? raw;
      const orderId =
        str(raw?.order_id) ??
        str(raw?.orderId) ??
        str(raw?.OrderId) ??
        str(success?.order_id);
      const httpStatus = typeof raw?.Status === 'number' ? raw.Status : null;
      const message = firstMessage(
        raw?.message,
        raw?.Error,
        success?.message,
        typeof raw === 'string' ? raw : null,
      );
      if (orderId) {
        return succeed(orderId, raw, { httpStatus, brokerMessage: message });
      }
      return fail(classifyBrokerMessage(message), message ?? 'ICICI Direct did not return an order id', raw, {
        httpStatus,
      });
    }

    case Broker.ZERODHA:
    default: {
      // Kite `placeOrder` returns the order id (string) or `{ order_id }`.
      const orderId =
        typeof raw === 'string'
          ? str(raw)
          : str(raw?.order_id) ?? str(raw?.orderId) ?? str(raw?.orderid);
      const message = firstMessage(
        typeof raw === 'object' ? raw?.message : null,
        typeof raw === 'object' ? raw?.error : null,
      );
      if (orderId) {
        return succeed(orderId, raw, { brokerMessage: message });
      }
      return fail(classifyBrokerMessage(message), message ?? 'Broker returned no order id', raw);
    }
  }
}

/** Normalize a thrown adapter error into a standardized failure outcome. */
export function normalizeExecutionError(
  _broker: Broker,
  err: any,
): NormalizedExecutionOutcome {
  const httpStatus =
    (typeof err?.response?.status === 'number' ? err.response.status : null) ??
    (typeof err?.status === 'number' ? err.status : null);

  const code = String(err?.code ?? '');
  const message = firstMessage(
    err?.message,
    err?.emsg,
    err?.error,
    err?.error_type,
    err?.response?.data?.message,
    typeof err === 'string' ? err : null,
  );

  let category: ExecutionResultCategory;
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN/.test(code)) {
    category = ExecutionResultCategory.NETWORK_FAILURE;
  } else if (/ETIMEDOUT/.test(code)) {
    category = ExecutionResultCategory.BROKER_TIMEOUT;
  } else if (httpStatus === 429) {
    category = ExecutionResultCategory.BROKER_RATE_LIMIT;
  } else if (httpStatus === 401 || httpStatus === 403) {
    category = ExecutionResultCategory.AUTHENTICATION_FAILED;
  } else if (httpStatus === 502 || httpStatus === 503) {
    category = ExecutionResultCategory.BROKER_UNAVAILABLE;
  } else {
    category = classifyBrokerMessage(message);
  }

  const snapshot: Record<string, unknown> = {};
  for (const key of ['name', 'message', 'error_type', 'code', 'status', 'statusText']) {
    const v = err?.[key];
    if (v !== undefined && v !== null) snapshot[key] = v;
  }
  const respData = err?.response?.data;
  if (respData !== undefined && respData !== null) {
    try {
      snapshot.brokerResponse = JSON.parse(JSON.stringify(respData));
    } catch {
      snapshot.brokerResponse = String(respData);
    }
  }

  return fail(category, message ?? 'Broker adapter threw an error', snapshot, {
    httpStatus,
  });
}
