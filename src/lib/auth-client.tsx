"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api-client";

export type SessionUser = {
  id: string;
  name?: string | null;
  email: string;
  role: "TENANT" | "LANDLORD" | "ADMIN";
  accountType?: "tenant" | "landlord";
};

type Session = { user: SessionUser } | null;
type Status = "loading" | "authenticated" | "unauthenticated";

const TOKEN_KEY = "rentfindr_token";
const USER_KEY = "rentfindr_user";

let state: { session: Session; status: Status } = { session: null, status: "loading" };
const listeners = new Set<() => void>();

function setState(next: { session: Session; status: Status }) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return state;
}

const serverSnapshot = { session: null as Session, status: "loading" as Status };

function getServerSnapshot() {
  return serverSnapshot;
}

function loadFromStorage() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const rawUser = localStorage.getItem(USER_KEY);
    if (token && rawUser) {
      setState({ session: { user: JSON.parse(rawUser) }, status: "authenticated" });
    } else {
      setState({ session: null, status: "unauthenticated" });
    }
  } catch {
    setState({ session: null, status: "unauthenticated" });
  }
}

// Replaces next-auth/react's <SessionProvider> — same children-passthrough shape,
// just hydrates the module-level session store from localStorage on mount instead
// of reading a same-origin session cookie.
export function AuthProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    loadFromStorage();
  }, []);
  return children as React.ReactElement;
}

// Same return shape as next-auth/react's useSession(): { data, status }.
export function useSession() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { data: snapshot.session, status: snapshot.status };
}

// Same call signature as next-auth/react's signIn("credentials", {...}) for the
// one call site that uses it (src/app/auth/page.tsx) — provider name is ignored,
// there's only ever one (email+password against the backend).
export async function signIn(
  _provider: "credentials",
  options: { email: string; password: string; redirect?: boolean },
): Promise<{ error?: string } | undefined> {
  const response = await apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: options.email, password: options.password }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return { error: result.error || "Invalid email or password." };

  try {
    localStorage.setItem(TOKEN_KEY, result.token);
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));
  } catch {
    // localStorage unavailable (private mode etc.) — session just won't persist across reloads.
  }
  setState({ session: { user: result.user }, status: "authenticated" });
  return undefined;
}

// Same call signature as next-auth/react's signOut({ callbackUrl }).
export function signOut(options?: { callbackUrl?: string }) {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
  setState({ session: null, status: "unauthenticated" });
  if (options?.callbackUrl && typeof window !== "undefined") {
    window.location.href = options.callbackUrl;
  }
}
