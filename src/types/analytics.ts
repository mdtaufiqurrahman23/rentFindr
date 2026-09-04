// Plain type definitions for the analytics payloads fetched from the backend
// (GET /api/analytics/landlord, /api/analytics/tenant) — the Prisma-backed
// computation now lives in backend/services/analytics.js.

export type NullableTrustBreakdown = {
  payment: number | null;
  maintenance: number | null;
  disputes: number | null;
  verification: number | null;
  reviews: number | null;
  agreements: number | null;
};

export type TrustPoint = { label: string; score: number | null };

export type LandlordAnalytics = {
  occupancy: { rate: number | null; occupied: number; totalActive: number };
  income: { currentMonthTotal: number; trend: { label: string; total: number }[] };
  improvementSpend: { currentMonthTotal: number; trend: { label: string; total: number }[] };
  netYield: { currentMonthTotal: number; trend: { label: string; total: number }[] };
  vacancy: { avgDays: number | null; sampleSize: number };
  maintenance: {
    avgResolutionHours: number | null;
    withinSlaRate: number | null;
    totalResolved: number;
    openOverdue: number;
  };
  deposits: { totalHeld: number; activeCount: number };
  trust: { score: number | null; breakdown: NullableTrustBreakdown; trend: TrustPoint[] };
  insights: string[];
};

export type TenantAnalytics = {
  payments: {
    totalLogged: number;
    totalPaid: number;
    completionRate: number | null;
    percentile: number | null;
  };
  maintenance: { filed: number; avgResolutionHours: number | null };
  deposits: { totalPaid: number; activeCount: number };
  trust: { score: number | null; breakdown: NullableTrustBreakdown; trend: TrustPoint[] };
  insights: string[];
};
