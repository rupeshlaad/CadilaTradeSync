'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, auth } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TermsDialog } from '@/components/terms-dialog';
import type { PublicUser, EligibilityResult } from '@cts/shared';

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [eligibility, setEligibility] = useState<EligibilityResult | null>(null);
  const [termsOpen, setTermsOpen] = useState(false);

  // Change password form
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);

  function refresh() {
    api.me().then(setUser).catch(() => {});
    api.eligibility().then(setEligibility).catch(() => {});
  }

  useEffect(() => {
    refresh();
    // Refresh when Terms are accepted anywhere (e.g. the app-wide Terms gate).
    const onAccepted = () => refresh();
    window.addEventListener('cts:terms-accepted', onAccepted);
    return () => window.removeEventListener('cts:terms-accepted', onAccepted);
  }, []);

  async function onChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(null);
    if (next !== confirm) {
      setPwError('New passwords do not match.');
      return;
    }
    setPwLoading(true);
    try {
      const res = await api.changePassword(current, next);
      setPwSuccess(res.message ?? 'Your password has been changed. Please sign in again.');
      // Password change revokes ALL sessions (incl. this one). Force re-login.
      auth.clear();
      setTimeout(() => router.push('/login?pwchanged=1'), 1200);
    } catch (err: any) {
      setPwError(err.message ?? 'Could not change password.');
    } finally {
      setPwLoading(false);
    }
  }

  async function onResendVerification() {
    setNotice(null);
    try {
      const res = await api.resendVerification(user!.email);
      setNotice(
        res.emailConfigured === false
          ? 'Email delivery is not configured in this environment yet, so no email was sent. Ask your administrator to configure SMTP.'
          : res.message,
      );
    } catch (err: any) {
      setNotice(err.message ?? 'Could not resend right now.');
    }
  }

  const emailVerified = !!user?.emailVerified;
  const termsAccepted = !!user?.termsAcceptedAt;

  // Actionable path for each unmet eligibility check.
  function actionFor(key: string): { label: string; onClick: () => void; testid: string } | null {
    switch (key) {
      case 'EMAIL_VERIFIED':
        return { label: 'Resend email', onClick: onResendVerification, testid: 'eligibility-action-EMAIL_VERIFIED' };
      case 'TERMS_ACCEPTED':
        return { label: 'Review & accept', onClick: () => setTermsOpen(true), testid: 'eligibility-action-TERMS_ACCEPTED' };
      case 'PROFILE_COMPLETE':
        return null;
      case 'BROKER_READY':
        return { label: 'Connect broker', onClick: () => router.push('/dashboard/broker-accounts'), testid: 'eligibility-action-BROKER_READY' };
      case 'STRATEGY_READY':
      case 'SUBSCRIPTION_READY':
        return { label: 'Browse strategies', onClick: () => router.push('/dashboard/marketplace'), testid: `eligibility-action-${key}` };
      default:
        return null;
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Settings</h2>
        <p className="text-muted-foreground">Manage your profile and account security.</p>
      </div>

      <TermsDialog open={termsOpen} onOpenChange={setTermsOpen} onAccepted={refresh} />

      {/* Live eligibility banner */}
      {eligibility && (
        <Card data-testid="eligibility-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Live Copy Trading Status
              {eligibility.liveEligible ? (
                <Badge data-testid="eligibility-badge">Live Eligible</Badge>
              ) : (
                <Badge variant="secondary" data-testid="eligibility-badge">Not Live Yet</Badge>
              )}
            </CardTitle>
            <CardDescription>
              {eligibility.liveEligible
                ? 'Your account meets all requirements for live copy trading.'
                : 'You are registered, but not yet enabled for live copy trading. Complete the steps below.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {eligibility.checks.map((c) => {
              const action = c.passed ? null : actionFor(c.key);
              return (
                <div key={c.key} className="flex items-center justify-between gap-2" data-testid={`eligibility-check-${c.key}`}>
                  <span className={c.passed ? '' : 'text-muted-foreground'}>{c.label}</span>
                  {c.passed ? (
                    <Badge variant="secondary">Done</Badge>
                  ) : action ? (
                    <Button variant="outline" size="sm" onClick={action.onClick} data-testid={action.testid}>
                      {action.label}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">{c.detail ?? 'Pending'}</span>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your account details.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div className="grid grid-cols-3 gap-2">
            <span className="text-muted-foreground">Email</span>
            <span className="col-span-2 flex items-center gap-2">
              {user?.email ?? '—'}
              {user && (emailVerified
                ? <Badge variant="secondary" data-testid="email-verified-badge">Verified</Badge>
                : <Badge variant="secondary" data-testid="email-unverified-badge">Unverified</Badge>)}
            </span>
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
            <span className="text-muted-foreground">Terms of Service</span>
            <span className="col-span-2 flex items-center gap-2">
              {termsAccepted
                ? <Badge variant="secondary" data-testid="terms-accepted-badge">Accepted (v{user?.termsVersion ?? '—'})</Badge>
                : <Badge variant="secondary" data-testid="terms-not-accepted-badge">Not accepted</Badge>}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <span className="text-muted-foreground">Member since</span>
            <span className="col-span-2">{user ? new Date(user.createdAt).toLocaleString() : '—'}</span>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            {user && !emailVerified && (
              <Button variant="outline" size="sm" onClick={onResendVerification} data-testid="settings-resend-verification-btn">
                Verify email (resend link)
              </Button>
            )}
            {user && !termsAccepted && (
              <Button variant="outline" size="sm" onClick={() => setTermsOpen(true)} data-testid="settings-accept-terms-btn">
                Review &amp; accept Terms
              </Button>
            )}
          </div>
          {notice && <p className="text-sm text-muted-foreground" data-testid="settings-notice">{notice}</p>}
        </CardContent>
      </Card>

      {/* Security */}
      <Card data-testid="security-card">
        <CardHeader>
          <CardTitle>Security</CardTitle>
          <CardDescription>Change your password.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onChangePassword} className="space-y-4 max-w-md">
            <div className="space-y-2">
              <Label htmlFor="current">Current password</Label>
              <Input id="current" type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} data-testid="change-current-input" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="next">New password</Label>
              <Input id="next" type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} data-testid="change-new-input" />
              <p className="text-xs text-muted-foreground">At least 8 characters, including a letter and a number.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input id="confirm" type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="change-confirm-input" />
            </div>
            {pwError && <p className="text-sm text-destructive" data-testid="change-error">{pwError}</p>}
            {pwSuccess && <p className="text-sm text-green-600" data-testid="change-success">{pwSuccess}</p>}
            <Button type="submit" disabled={pwLoading} data-testid="change-submit-btn">
              {pwLoading ? 'Saving…' : 'Change password'}
            </Button>
          </form>
          <p className="mt-4 text-xs text-muted-foreground">
            Forgot your password? Use the{' '}
            <a href="/forgot-password" className="text-primary hover:underline">Forgot password</a> page from sign-in.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
