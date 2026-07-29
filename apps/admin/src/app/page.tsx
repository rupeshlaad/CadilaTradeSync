'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/api';

export default function AdminIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace(auth.getToken() ? '/dashboard' : '/login');
  }, [router]);
  return <div className="min-h-screen grid place-items-center text-muted-foreground">Redirecting…</div>;
}
