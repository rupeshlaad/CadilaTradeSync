import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { ArrowRight, Shield, Zap, TrendingUp, Layers } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="border-b">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/candila-fintech-logo.webp" alt="Candila FinTech" className="h-8 w-auto rounded-md" />
            <span className="font-semibold text-lg">Candila TradeSync</span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#platform" className="hover:text-foreground">Platform</a>
            <a href="#security" className="hover:text-foreground">Security</a>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button variant="ghost" asChild>
              <Link href="/login">Log in</Link>
            </Button>
            <Button asChild>
              <Link href="/register">Get started</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="container py-24 md:py-32 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border bg-muted px-3 py-1 text-xs text-muted-foreground mb-6">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          Multi-broker copy trading, engineered for scale
        </div>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight max-w-3xl mx-auto">
          The trading infrastructure your desk deserves.
        </h1>
        <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
          Candila TradeSync is an enterprise multi-broker copy trading platform for orchestrating strategies across brokers —
          secure, observable and built for institutional workflows.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Button size="lg" asChild>
            <Link href="/register">
              Start free <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="container pb-24">
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Zap, title: 'Low-latency core', desc: 'Built on a Redis-backed event bus for sub-second sync.' },
            { icon: Shield, title: 'Role-based access', desc: 'Admin + user isolation with JWT and hardened defaults.' },
            { icon: Layers, title: 'Multi-broker ready', desc: 'Pluggable broker adapters ship-ready architecture.' },
            { icon: TrendingUp, title: 'Observable', desc: 'Health checks, structured logs, and future metrics.' },
          ].map((f) => (
            <div key={f.title} className="rounded-lg border p-6 bg-card">
              <f.icon className="h-6 w-6 text-primary" />
              <h3 className="mt-4 font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section id="platform" className="container pb-24">
        <div className="rounded-2xl border bg-gradient-to-br from-primary/10 via-background to-background p-10 md:p-16 text-center">
          <h2 className="text-3xl md:text-4xl font-bold">Foundation ready. Business logic next.</h2>
          <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
            This is the CTS platform scaffold — auth, dashboards, theme, and infrastructure wired end-to-end.
          </p>
          <div className="mt-8">
            <Button size="lg" asChild>
              <Link href="/register">Create your account</Link>
            </Button>
          </div>
        </div>
      </section>

      <footer className="border-t">
        <div className="container py-8 text-sm text-muted-foreground flex flex-col md:flex-row items-center justify-between gap-2">
          <div className="text-center md:text-left">
            <p>© 2026 Candila FinTech</p>
            <p className="text-xs">A Subsidiary of Candila Capital Pvt. Ltd.</p>
          </div>
          <p>Powered by Candila FinTech</p>
        </div>
      </footer>
    </div>
  );
}
