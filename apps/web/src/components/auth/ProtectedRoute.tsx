'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from './useAuth';

type ProtectedRouteProps = {
  mode: 'authenticated' | 'unauthenticated';
  children: React.ReactNode;
};

export function ProtectedRoute({ mode, children }: ProtectedRouteProps) {
  const router = useRouter();
  const { token, loading } = useAuth();

  useEffect(() => {
    if (loading) {
      return;
    }

    if (mode === 'authenticated' && !token) {
      router.replace('/');
      return;
    }

    if (mode === 'unauthenticated' && token) {
      router.replace('/app');
    }
  }, [loading, mode, router, token]);

  if (loading) {
    return null;
  }

  if (mode === 'authenticated' && !token) {
    return null;
  }

  if (mode === 'unauthenticated' && token) {
    return null;
  }

  return <>{children}</>;
}
