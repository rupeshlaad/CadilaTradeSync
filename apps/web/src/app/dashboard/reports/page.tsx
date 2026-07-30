'use client';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { FileBarChart } from 'lucide-react';

export default function ReportsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Reports</h2>
        <p className="text-muted-foreground">Analytics and P&amp;L reports across your accounts and strategies.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileBarChart className="h-5 w-5" /> Reporting engine</CardTitle>
          <CardDescription>Reports will be generated once the copy-trading engine begins executing.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <div>• Daily P&amp;L by strategy and follower</div>
          <div>• Risk-adjusted returns · Sharpe · max drawdown</div>
          <div>• Trade blotter with fills, slippage and latency</div>
          <div>• CSV / PDF export</div>
        </CardContent>
      </Card>
    </div>
  );
}
