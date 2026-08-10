'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { auth, api } from '@/lib/api';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import {
  LayoutDashboard,
  LineChart,
  Settings,
  LogOut,
  User,
  Wallet,
  Landmark,
} from 'lucide-react';
import type { PublicUser } from '@cts/shared';

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },

  {
    href: '/dashboard/broker-accounts',
    label: 'Broker Accounts',
    icon: Landmark,
  },

  {
    href: '/dashboard/marketplace',
    label: 'Marketplace',
    icon: LineChart,
  },

  {
    href: '/dashboard/followers',
    label: 'My Followers',
    icon: User,
  },

  {
    href: '/dashboard/subscriptions',
    label: 'Subscriptions',
    icon: Wallet,
  },

  {
    href: '/dashboard/reports',
    label: 'Reports',
    icon: LineChart,
  },

  {
    href: '/dashboard/settings',
    label: 'Settings',
    icon: Settings,
  },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = auth.getToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => {
        auth.clear();
        router.replace('/login');
      })
      .finally(() => setLoading(false));
  }, [router]);

  function handleLogout() {
    auth.clear();
    router.replace('/login');
  }

  if (loading) {
    return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="min-h-screen flex bg-background">
      {/* Sidebar */}
      <aside className="hidden md:flex w-64 flex-col border-r bg-card">
        <div className="h-16 flex items-center gap-2 px-6 border-b">
          <img src="/candila-fintech-logo.webp" alt="Candila FinTech" className="h-8 w-auto rounded-md" />
          <div>
            <div className="font-semibold text-sm leading-tight">Candila TradeSync</div>
            <div className="text-[10px] text-muted-foreground">Powered by Candila FinTech</div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map((n) => {
            const active = pathname === n.href;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                <n.icon className="h-4 w-4" />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t">
          <Button variant="ghost" className="w-full justify-start" onClick={handleLogout}>
            <LogOut className="h-4 w-4 mr-2" /> Sign out
          </Button>
          <div className="mt-3 px-2 text-[10px] leading-relaxed text-muted-foreground">
            <div>© 2026 Candila FinTech</div>
            <div>A Subsidiary of Candila Capital Pvt. Ltd.</div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b bg-card px-6 flex items-center justify-between">
          <h1 className="font-semibold">User Dashboard</h1>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <div className="flex items-center gap-2 pl-2 border-l">
              <div className="h-8 w-8 rounded-full bg-muted grid place-items-center">
                <User className="h-4 w-4" />
              </div>
              <div className="text-sm">
                <div className="font-medium leading-tight">{user?.name ?? user?.email}</div>
                <div className="text-xs text-muted-foreground">{user?.role}</div>
              </div>
            </div>
          </div>
        </header>
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}