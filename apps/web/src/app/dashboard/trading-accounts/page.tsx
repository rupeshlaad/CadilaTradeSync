'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Sprint 6.1.2 — "Trading Accounts" and "Broker Accounts" managed the same
 * follower broker accounts (same `/trading-accounts` API). They are now
 * consolidated: Broker Accounts is the single broker-management page. This
 * legacy route redirects there so existing bookmarks keep working without
 * duplicating functionality.
 */
export default function TradingAccountsRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard/broker-accounts');
  }, [router]);

  return (
    <div
      className="min-h-[40vh] grid place-items-center text-sm text-muted-foreground"
      data-testid="trading-accounts-redirect"
    >
      Redirecting to Broker Accounts…
    </div>
  );
}
