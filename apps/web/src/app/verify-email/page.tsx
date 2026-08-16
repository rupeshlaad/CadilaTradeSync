'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { api } from '@/lib/api';

type State = 'verifying' | 'success' | 'error';

function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<State>('verifying');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    if (!token) {
      setState('error');
      setMessage('Missing or invalid verification link.');
      return;
    }
    api
      .verifyEmail(token)
      .then((res) => {
        if (!active) return;
        setState('success');
        setMessage(res.message);
      })
      .catch((err: any) => {
        if (!active) return;
        setState('error');
        setMessage(err.message ?? 'This verification link is invalid or has expired.');
      });
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Email verification</CardTitle>
        <CardDescription>
          {state === 'verifying' ? 'Verifying your email…' : 'Verification result'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state === 'verifying' && (
          <p className="text-sm text-muted-foreground" data-testid="verify-status">Please wait…</p>
        )}
        {state === 'success' && (
          <div className="rounded-md border bg-muted/40 p-4 text-sm" data-testid="verify-success">{message}</div>
        )}
        {state === 'error' && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" data-testid="verify-error">{message}</div>
        )}
        <Button asChild className="w-full">
          <Link href="/dashboard">Go to dashboard</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen grid place-items-center bg-background p-4">
      <div className="absolute top-4 right-4"><ThemeToggle /></div>
      <Suspense fallback={<div className="text-sm text-muted-foreground">Loading…</div>}>
        <VerifyEmailInner />
      </Suspense>
    </div>
  );
}
