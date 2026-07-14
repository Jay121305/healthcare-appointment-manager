// lib/hooks.ts
// Shared client hooks used across patient/doctor/admin portals.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useCountdown(seconds)
 * Returns the remaining seconds and an explicit setter+reset. Runs a 1s
 * interval while remaining > 0. Reaches 0 → the onExpire callback fires once.
 * The countdown derives the initial remaining time from `seconds`, but each
 * tick decrements by the wall-clock delta so a stalled JS timer can never
 * overstate the remaining time. (Rule-implied — see A14(M7) notes.)
 */
export function useCountdown(
  initialSeconds: number,
  onExpire?: () => void,
): {
  remaining: number;
  isExpired: boolean;
  start: (secs?: number) => void;
  stop: () => void;
  reset: () => void;
} {
  const [remaining, setRemaining] = useState(Math.max(0, Math.floor(initialSeconds)));
  const [isExpired, setIsExpired] = useState(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTickRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      lastTickRef.current = null;
    }
  }, []);

  const start = useCallback(
    (secs?: number) => {
      clear();
      const initial = Math.max(0, Math.floor(secs ?? initialSeconds));
      setRemaining(initial);
      setIsExpired(false);
      if (initial <= 0) return;
      lastTickRef.current = Date.now();
      intervalRef.current = setInterval(() => {
        const now = Date.now();
        const last = lastTickRef.current ?? now;
        const delta = Math.max(1, Math.round((now - last) / 1000));
        lastTickRef.current = now;
        setRemaining((prev) => {
          const next = Math.max(0, prev - delta);
          if (next === 0) {
            clear();
            setIsExpired(true);
            onExpireRef.current?.();
          }
          return next;
        });
      }, 1000);
    },
    [clear, initialSeconds],
  );

  const stop = useCallback(() => {
    clear();
  }, [clear]);

  const reset = useCallback(() => {
    clear();
    setRemaining(0);
    setIsExpired(false);
  }, [clear]);

  useEffect(() => {
    return () => clear();
  }, [clear]);

  return { remaining, isExpired, start, stop, reset };
}

/**
 * usePoll(fn, { enabled, intervalMs })
 * Calls `fn` on a fixed interval while enabled. Clears on unmount or disable.
 */
export function usePoll(
  fn: () => void | Promise<void>,
  options: { enabled: boolean; intervalMs: number; immediate?: boolean },
): { stop: () => void } {
  const { enabled, intervalMs, immediate } = options;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }
    if (immediate) {
      void fnRef.current();
    }
    intervalRef.current = setInterval(() => {
      void fnRef.current();
    }, intervalMs);
    return stop;
  }, [enabled, intervalMs, immediate, stop]);

  return { stop };
}

/**
 * useMounted() — guards against setState-on-unmounted warnings for
 * components that suspend fetches after first paint.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}
