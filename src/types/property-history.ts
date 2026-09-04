// Plain type for the anonymized property-history panel data fetched from the
// backend (part of GET /api/listings/:listingId/detail) — the Prisma-backed
// computation now lives in backend/services/property-history.js.

export type PropertyHistory = {
  pastTenancyCount: number;
  avgTenancyMonths: number | null;
  resolvedDisputeCount: number;
  totalDisputeCount: number;
};
