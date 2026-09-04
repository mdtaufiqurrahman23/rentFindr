const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const TOKEN_KEY = "rentfindr_token";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

// Drop-in replacement for the app's existing same-origin fetch("/api/...") calls —
// same path strings, just routed to the separate backend origin with the stored
// Bearer token attached, since the backend is no longer same-origin (no more
// automatic cookie auth).
export function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${API_URL}${path}`, { ...options, headers });
}

export { API_URL };
