// Ported from src/lib/reviews.ts (plain, Prisma-free helper — not a
// `.server.ts` file, but imported by src/app/api/reviews/route.ts, so it
// needs a backend copy too). Asymmetric by role, per the proposal: a tenant
// rates the landlord on these three categories, a landlord rates the tenant
// on a different three. Shared between the controller (validation) and, on
// the frontend, the client component (labels) — kept in sync manually since
// they now live in separate projects.
export const LANDLORD_REVIEW_CATEGORIES = [
  { key: "responsiveness", label: "Responsiveness" },
  { key: "listingAccuracy", label: "Listing accuracy" },
  { key: "maintenanceQuality", label: "Maintenance quality" },
];

export const TENANT_REVIEW_CATEGORIES = [
  { key: "paymentPunctuality", label: "Payment punctuality" },
  { key: "propertyCare", label: "Property care" },
  { key: "communication", label: "Communication" },
];

export function categoriesForRatee(rateeIsLandlord) {
  return rateeIsLandlord ? LANDLORD_REVIEW_CATEGORIES : TENANT_REVIEW_CATEGORIES;
}

export function overallFromCategories(categoryRatings) {
  const values = Object.values(categoryRatings);
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}
