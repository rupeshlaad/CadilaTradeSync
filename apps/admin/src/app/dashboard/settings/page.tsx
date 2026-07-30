'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { PublicUser } from '@cts/shared';

export default function AdminSettingsPage() {
  const [user, setUser] = useState<PublicUser | null>(null);

  useEffect(() => {
    api.me().then(setUser).catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Settings</h2>
        <p className="text-muted-foreground">Platform configuration and administrator profile.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Administrator</CardTitle>
          <CardDescription>Current signed-in admin.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div className="grid grid-cols-3 gap-2">
            <span className="text-muted-foreground">Email</span>
            <span className="col-span-2">{user?.email ?? '—'}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <span className="text-muted-foreground">Name</span>
            <span className="col-span-2">{user?.name ?? '—'}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <span className="text-muted-foreground">Role</span>
            <span className="col-span-2"><Badge variant="default">{user?.role ?? '—'}</Badge></span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Encryption</CardTitle>
          <CardDescription>Credential encryption backend.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>Current implementation: <span className="font-mono">PlaceholderEncryptionService</span> (v0, base64).</p>
          <p>Replace with KMS-backed AES-256-GCM before going to production.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <div>• Feature flags &amp; broker adapter registry</div>
          <div>• Audit log retention &amp; export</div>
          <div>• API keys and webhooks for platform integrations</div>
          <div>• Global risk kill-switch</div>
        </CardContent>
      </Card>
    </div>
  );
}
