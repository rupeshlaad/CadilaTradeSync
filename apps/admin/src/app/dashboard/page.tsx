'use client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function AdminOverview() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Welcome to Candila TradeSync</h2>
        <p className="text-muted-foreground">Enterprise Multi-Broker Copy Trading Platform</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {[
          { title: 'Total Users', value: '—' },
          { title: 'Admins', value: '—' },
          { title: 'Active Sessions', value: '—' },
          { title: 'API Health', value: 'OK' },
        ].map((s) => (
          <Card key={s.title}>
            <CardHeader className="pb-2">
              <CardDescription>{s.title}</CardDescription>
              <CardTitle className="text-3xl">{s.value}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">Metrics module coming soon</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Admin capabilities</CardTitle>
          <CardDescription>Modules planned on top of this foundation</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <div>• User management · role assignment · KYC status</div>
          <div>• Broker adapter registry &amp; feature flags</div>
          <div>• System monitoring · audit logs · impersonation</div>
          <div>• Billing overview · subscription tiers</div>
        </CardContent>
      </Card>
    </div>
  );
}
