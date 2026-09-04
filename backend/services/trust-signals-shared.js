// Backend copy of the pure part of src/lib/trust-signals.ts (no Prisma) —
// named "-shared" to avoid colliding with the ported
// src/lib/trust-signals.server.ts (-> services/trust-signals.js).
// Used by services/landlord-summary.js.

export function formatLastActive(iso) {
  if (!iso) return "No activity yet";
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffHours = diffMs / 3_600_000;
  if (diffHours < 1) return "Active just now";
  if (diffHours < 24) return `Active ${Math.round(diffHours)}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `Active ${diffDays}d ago`;
  return `Last active ${new Date(iso).toLocaleDateString()}`;
}
