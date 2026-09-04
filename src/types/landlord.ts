// Plain type definitions shared by client components that display landlord
// summary data fetched from the backend API — kept frontend-side (unlike the
// Prisma-backed functions that produce this shape, which live in the
// backend now) since these are just TypeScript shapes, not server logic.

export type LandlordSummary = {
  id: string;
  name: string;
  verified: boolean;
  verifiedSince: string | null;
  totalListings: number;
  totalApplicants: number;
};

export type LandlordDocumentItem = {
  id: string;
  type: "utility_bill" | "sublet_agreement";
  label: string;
  fileUrl: string;
  createdAt: string;
};

export type LandlordPublicProfile = LandlordSummary & {
  completedRentals: number;
  avgResponseHours: number | null;
  lastActiveLabel: string;
  documents: LandlordDocumentItem[];
};
