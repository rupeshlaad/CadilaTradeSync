'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function DashboardHome() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Welcome to Cadila TradeSync</h2>
        <p className="text-muted-foreground">Your foundation is ready. Business modules will appear here.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {[
          { title: 'Connected Brokers', value: '0', desc: 'Broker adapters coming soon' },
          { title: 'Active Strategies', value: '0', desc: 'Copy-trading engine coming soon' },
          { title: 'Portfolio Value', value: '₹ 0.00', desc: 'Wallet module coming soon' },
        ].map((s) => (
          <Card key={s.title}>
            <CardHeader className="pb-2">
              <CardDescription>{s.title}</CardDescription>
              <CardTitle className="text-3xl">{s.value}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{s.desc}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Roadmap</CardTitle>
          <CardDescription>Modules planned on top of this foundation</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <div>• Broker integrations (Zerodha, Upstox, Angel One, IBKR)</div>
          <div>• Copy trading engine with leader/follower isolation</div>
          <div>• Real-time positions, orders, P&L via WebSockets</div>
          <div>• Billing & subscription management</div>
          <div>• Compliance and audit trails</div>
        </CardContent>
      </Card>
    </div>
  );
}
