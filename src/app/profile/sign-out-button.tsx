"use client";

import { signOut } from "@/lib/auth-client";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => void signOut({ callbackUrl: "/" })}
      className="rounded-full border border-border px-4 py-2 text-xs hover:bg-secondary"
    >
      Sign out
    </button>
  );
}
