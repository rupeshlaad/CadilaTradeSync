'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ThemeToggle } from '@/components/theme-toggle';
import { api } from '@/lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [resendMsg, setResendMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.register(email, password, name || undefined);
      // Email verification is the first gate — no session is issued at
      // registration. The user must verify, then sign in.
      setEmailSent(res.emailVerificationSent ?? false);
      setRegistered(true);
    } catch (err: any) {
      setError(err.message ?? 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  async function onResend() {
    setResendMsg(null);
    try {
      const res = await api.resendVerification(email);
      setResendMsg(
        res.emailConfigured === false
          ? 'Email delivery is not configured in this environment yet, so no email was sent. You can verify later once your administrator configures email.'
          : res.message,
      );
    } catch (err: any) {
      setResendMsg(err.message ?? 'Could not resend right now.');
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-background p-4">
      <div className="absolute top-4 right-4"><ThemeToggle /></div>
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex flex-col items-center text-center gap-3 mb-2">
            <img src="/candila-fintech-logo.webp" alt="Candila FinTech" className="h-14 w-auto rounded-md" />
            <div>
              <div className="text-xl font-bold">Candila TradeSync</div>
              <div className="text-xs text-muted-foreground">Enterprise Multi-Broker Copy Trading Platform</div>
            </div>
          </div>
          <CardTitle>{registered ? 'Verify your email' : 'Create account'}</CardTitle>
          <CardDescription>
            {registered
              ? 'Your account was created. Verify your email to activate sign-in.'
              : 'Get started with your Candila TradeSync workspace.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {registered ? (
            <div className="space-y-4" data-testid="register-verify-notice">
              <div className="rounded-md border bg-muted/40 p-4 text-sm space-y-2">
                {emailSent ? (
                  <p>
                    We&apos;ve sent a verification link to <span className="font-medium">{email}</span>.
                    Open it to verify your email.
                  </p>
                ) : (
                  <p data-testid="register-email-not-configured">
                    Your account is created. Email delivery is <span className="font-medium">not configured in this environment yet</span>,
                    so no verification email was sent. Ask your administrator to configure email, then use “Resend link”.
                  </p>
                )}
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">You must verify your email before you can sign in.</span>{' '}
                  After verifying, sign in to continue onboarding (accept Terms, connect a broker, choose a strategy).
                  Live copy trading stays locked until those steps are complete.
                </p>
              </div>
              {resendMsg && <p className="text-sm text-muted-foreground" data-testid="register-resend-msg">{resendMsg}</p>}
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={onResend} data-testid="register-resend-btn">
                  Resend link
                </Button>
                <Button className="flex-1" onClick={() => router.push('/login')} data-testid="register-continue-btn">
                  Go to sign in
                </Button>
              </div>
            </div>
          ) : (
            <>
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" data-testid="register-name-input" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" data-testid="register-email-input" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="register-password-input" />
                  <p className="text-xs text-muted-foreground">At least 8 characters, including a letter and a number.</p>
                </div>
                {error && <p className="text-sm text-destructive" data-testid="register-error">{error}</p>}
                <Button type="submit" className="w-full" disabled={loading} data-testid="register-submit-btn">
                  {loading ? 'Creating…' : 'Create account'}
                </Button>
              </form>
              <p className="mt-6 text-sm text-center text-muted-foreground">
                Already have an account?{' '}
                <Link href="/login" className="text-primary hover:underline">Sign in</Link>
              </p>
            </>
          )}
          <p className="mt-3 text-xs text-center text-muted-foreground">Powered by Candila FinTech</p>
        </CardContent>
      </Card>
    </div>
  );
}
