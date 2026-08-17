'use client';

import { useEffect, useState } from 'react';
import { TermsDialog } from '@/components/terms-dialog';

/**
 * Sprint 1 — App-wide handler for the server-side Terms gate.
 *
 * Any broker/strategy API call that returns TERMS_ACCEPTANCE_REQUIRED causes
 * `api.request()` to dispatch a `cts:terms-required` event. This component
 * listens for it and opens the EXISTING Terms acceptance dialog (no duplicate
 * dialog / no duplicate state). After acceptance the user can retry the action.
 */
export function TermsRequiredGate() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('cts:terms-required', handler);
    return () => window.removeEventListener('cts:terms-required', handler);
  }, []);

  return (
    <TermsDialog
      open={open}
      onOpenChange={setOpen}
      intro={
        'Terms & Conditions Required — Please read and accept the Terms of Service before continuing with broker setup and strategy configuration.'
      }
      onAccepted={() => {
        setOpen(false);
        // Notify listeners (dashboard/settings) so they can refresh state.
        window.dispatchEvent(new CustomEvent('cts:terms-accepted'));
      }}
    />
  );
}
