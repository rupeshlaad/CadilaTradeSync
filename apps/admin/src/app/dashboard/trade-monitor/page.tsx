'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Activity } from 'lucide-react';

export default function TradeMonitorPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Trade Monitor</h2>
        <p className="text-muted-foreground">Real-time execution flow across all master and follower accounts.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5" /> Live trade stream</CardTitle>
          <CardDescription>The live trade blotter activates once the copy-trading engine is enabled.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <div>• Signal ingestion from master accounts</div>
          <div>• Fan-out to follower accounts with multiplier + risk clamps</div>
          <div>• Order acknowledgements, fills, slippage and latency</div>
          <div>• Failure diagnostics with per-follower retry state</div>
        </CardContent>
      </Card>
    </div>
  );
}
