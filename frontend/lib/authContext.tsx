// lib/authContext.tsx
// React context holding the in-memory user + role. Login/logout/read-user
// are exposed through this provider so any role-gated component can read
// from a single source of truth. Client-side role gating here is UX only
// (Rule 1) — every API call is independently authorized by the backend.

'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setAuthTokens, clearAuthTokens, getAccessToken } from './api';
import type { Role, UserProfile } from './types';

interface AuthContextValue {
  user: UserProfile | null;
  role: Role | null;
  loading: boolean;
  setUser: (user: UserProfile | null) => void;
  setSession: (accessToken: string, refreshToken: string, user: UserProfile) => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<UserProfile | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ROLE_COOKIE = 'role';

function readRoleCookie(): Role | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${ROLE_COOKIE}=`));
  if (!match) return null;
  const value = match.split('=')[1] as Role;
  if (value === 'PATIENT' || value === 'DOCTOR' || value === 'ADMIN') return value;
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<UserProfile | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount: if an in-memory access token exists, fetch /auth/me once to
  // rehydrate the user object. If it fails we silently clear and stay on
  // the public shell — the next protected navigation will redirect to /login.
  useEffect(() => {
    let cancelled = false;
    const token = getAccessToken();
    const roleCookie = readRoleCookie();
    if (roleCookie) setRole(roleCookie);
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((u) => {
        if (cancelled) return;
        setUserState(u);
        setRole(u.role);
      })
      .catch(() => {
        if (cancelled) return;
        // access token may be stale and refresh failed — clear and stay quiet
        clearAuthTokens();
        setRole(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setSession = useCallback(
    (accessToken: string, refreshToken: string, u: UserProfile) => {
      setAuthTokens(accessToken, refreshToken, u.role);
      setUserState(u);
      setRole(u.role);
    },
    [],
  );

  const setUser = useCallback((u: UserProfile | null) => {
    setUserState(u);
    if (u) setRole(u.role);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // best-effort — clear local state regardless
    }
    clearAuthTokens();
    setUserState(null);
    setRole(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const u = await api.me();
      setUserState(u);
      setRole(u.role);
      return u;
    } catch {
      return null;
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, role, loading, setUser, setSession, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
