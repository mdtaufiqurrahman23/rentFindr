// Backend copy of src/lib/lease-timeline.ts (pure date math, no Prisma) —
// named "-shared" rather than "lease-timeline.js" to avoid colliding with
// the ported src/lib/lease-timeline.server.ts (-> services/lease-timeline.js).
// Used by services/lease-timeline.js and services/reminders.js so both
// compute the exact same lease end date from the exact same inputs.

export function computeLeaseEndDate(availableFrom, durationMonths) {
  const end = new Date(availableFrom);
  end.setMonth(end.getMonth() + durationMonths);
  return end;
}

// Matches the 30-day reminder threshold in reminders.js — the
// "renewal-decision window" is defined as the same stretch that already
// triggers the first expiry email, not a separate, disconnected concept.
export const RENEWAL_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeLeaseTimeline(availableFrom, durationMonths, now = new Date()) {
  const endDate = computeLeaseEndDate(availableFrom, durationMonths);
  const totalMs = Math.max(1, endDate.getTime() - availableFrom.getTime());
  const elapsedMs = now.getTime() - availableFrom.getTime();
  const renewalWindowStart = new Date(endDate.getTime() - RENEWAL_WINDOW_DAYS * DAY_MS);

  return {
    moveInDate: availableFrom.toISOString(),
    endDate: endDate.toISOString(),
    totalDays: Math.round(totalMs / DAY_MS),
    elapsedDays: Math.round(elapsedMs / DAY_MS),
    elapsedPercent: Math.min(100, Math.max(0, Math.round((elapsedMs / totalMs) * 100))),
    daysRemaining: Math.round((endDate.getTime() - now.getTime()) / DAY_MS),
    renewalWindowStart: renewalWindowStart.toISOString(),
    renewalWindowPercent: Math.min(
      100,
      Math.max(
        0,
        Math.round(((renewalWindowStart.getTime() - availableFrom.getTime()) / totalMs) * 100),
      ),
    ),
    inRenewalWindow: now >= renewalWindowStart && now <= endDate,
    isExpired: now > endDate,
  };
}
