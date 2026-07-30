'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { PublicUser } from '@cts/shared';

export default function SettingsPage() {
  const [user, setUser] = useState<PublicUser | null>(null);

  useEffect(() => {
    api.me().then(setUser).catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Settings</h2>
        <p className="text-muted-foreground">Manage your profile and workspace preferences.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Read-only profile details.</CardDescription>
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
            <span className="col-span-2"><Badge variant="secondary">{user?.role ?? '—'}</Badge></span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <span className="text-muted-foreground">Member since</span>
            <span className="col-span-2">{user ? new Date(user.createdAt).toLocaleString() : '—'}</span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <div>• Password change and two-factor authentication</div>
          <div>• API keys and webhooks</div>
          <div>• Notification preferences</div>
          <div>• Billing and plan management</div>
        </CardContent>
      </Card>
    </div>
  );
}
