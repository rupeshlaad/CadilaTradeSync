'use client';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { auth, api } from '@/lib/api';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { LayoutDashboard, Users, Shield, Server, LogOut, Database, Play, Zap } from 'lucide-react';
import { Role, type PublicUser } from '@cts/shared';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/master-accounts', label: 'Master Accounts', icon: Server },
  { href: '/dashboard/strategies', label: 'Strategies', icon: Shield },
  { href: '/dashboard/strategy-execution', label: 'Strategy Execution', icon: Play },
  { href: '/dashboard/manual-trading', label: 'Manual Trading', icon: Zap },
  { href: '/dashboard/followers', label: 'Followers', icon: Users },
  { href: '/dashboard/trade-monitor', label: 'Trade Monitor', icon: LayoutDashboard },
  { href: '/dashboard/instruments', label: 'Instruments', icon: Database },
  { href: '/dashboard/users', label: 'Users', icon: Users },
  { href: '/dashboard/settings', label: 'Settings', icon: Shield },
];

export default function AdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = auth.getToken();
    if (!token) { router.replace('/login'); return; }
    api.me()
      .then((u) => {
        if (u.role !== Role.ADMIN) {
          auth.clear();
          router.replace('/login');
          return;
        }
        setUser(u);
      })
      .catch(() => { auth.clear(); router.replace('/login'); })
      .finally(() => setLoading(false));
  }, [router]);

  function handleLogout() { auth.clear(); router.replace('/login'); }

  if (loading) return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading…</div>;

  return (
    <div className="min-h-screen flex bg-background">
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

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b bg-card px-6 flex items-center justify-between">
          <div>
            <h1 className="font-semibold">Admin Dashboard</h1>
            <p className="text-xs text-muted-foreground">Signed in as {user?.email}</p>
          </div>
          <ThemeToggle />
        </header>
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
