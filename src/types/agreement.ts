// Plain type definitions for agreement data shapes shared by client-side
// code (PDF generation, the read-only share view) — the logic that produces
// these (AI drafting, Prisma persistence) now lives in the backend.

export type AgreementTerms = {
  reference: string;
  landlordName: string;
  landlordVerifiedSince: string;
  tenantName: string;
  tenantNid: string;
  tenantPhone: string;
  propertyTitle: string;
  roomType: string;
  area: string;
  city: string;
  coords: string;
  rent: number;
  deposit: number;
  durationMonths: number;
  startDate: string;
  endDate: string;
  houseRules: string[];
};

export type AgreementClause = { title: string; body: string };
