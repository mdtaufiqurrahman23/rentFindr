// Copied from src/lib/maintenance.ts (pure, Prisma-free) — kept as a
// self-contained backend copy per the frontend/backend split; the original
// stays in src/lib for frontend display logic. Used by services/analytics.js.

export const MAINTENANCE_SLA_HOURS = 48;

export function isOverdue(status, createdAt) {
  if (status === "resolved") return false;
  const deadline = new Date(createdAt).getTime() + MAINTENANCE_SLA_HOURS * 60 * 60 * 1000;
  return Date.now() > deadline;
}
