'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

/**
 * Sprint 1 remediation — real Terms & Conditions acceptance flow.
 *
 * The user must open the dialog, see the version + content, and explicitly
 * click "I Accept" — acceptance is NEVER triggered by clicking descriptive
 * text. Backend (POST /auth/accept-terms) is the single source of truth; the
 * onAccepted callback lets the parent refresh the shared onboarding state.
 */
export function TermsDialog({
  open,
  onOpenChange,
  onAccepted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccepted: () => void;
}) {
  const [terms, setTerms] = useState<{ version: string; content: string } | null>(null);
  const [ack, setAck] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setAck(false);
      api.getTerms().then(setTerms).catch(() => setError('Could not load the terms right now.'));
    }
  }, [open]);

  async function accept() {
    if (!ack) return;
    setLoading(true);
    setError(null);
    try {
      await api.acceptTerms(terms?.version);
      onOpenChange(false);
      onAccepted();
    } catch (err: any) {
      setError(err.message ?? 'Could not accept the terms. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="terms-dialog">
        <DialogHeader>
          <DialogTitle>Terms of Service</DialogTitle>
          <DialogDescription>
            Version {terms?.version ?? '—'} — please read and accept to continue.
          </DialogDescription>
        </DialogHeader>

        <div
          className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap"
          data-testid="terms-content"
        >
          {terms?.content ?? 'Loading…'}
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            data-testid="terms-ack-checkbox"
          />
          <span>
            I have read and agree to the Terms of Service (version {terms?.version ?? '—'}).
          </span>
        </label>

        {error && <p className="text-sm text-destructive" data-testid="terms-error">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="terms-cancel-btn">
            Cancel
          </Button>
          <Button onClick={accept} disabled={!ack || loading} data-testid="terms-accept-btn">
            {loading ? 'Saving…' : 'I Accept'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
