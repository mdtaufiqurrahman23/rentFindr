import { prisma } from "../models/prisma.js";
import { formatDate } from "./module1.js";
import { getLandlordTrustSignals } from "./trust-signals.js";
import { formatLastActive } from "./trust-signals-shared.js";

// LandlordSummary = { id, name, verified, verifiedSince, totalListings, totalApplicants }

const unknownSummary = (id) => ({
  id,
  name: "Landlord",
  verified: false,
  verifiedSince: null,
  totalListings: 0,
  totalApplicants: 0,
});

/**
 * Real, DB-backed replacement for the old `getLandlord()` mock lookup.
 * Verification status comes from the actual admin-reviewed `LandlordVerification`
 * row, not a hardcoded 3-entry table — so it reflects real landlords correctly.
 */
export async function getLandlordSummaries(landlordIds) {
  const ids = Array.from(new Set(landlordIds));
  const map = new Map();
  if (ids.length === 0) return map;

  const [users, listings] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        profile: {
          select: { landlordVerification: { select: { status: true, reviewedAt: true } } },
        },
      },
    }),
    prisma.listing.findMany({
      where: { landlordId: { in: ids } },
      select: { landlordId: true, _count: { select: { applications: true } } },
    }),
  ]);

  const byLandlord = new Map();
  for (const l of listings) {
    const agg = byLandlord.get(l.landlordId) ?? { totalListings: 0, totalApplicants: 0 };
    agg.totalListings += 1;
    agg.totalApplicants += l._count.applications;
    byLandlord.set(l.landlordId, agg);
  }

  for (const u of users) {
    const verification = u.profile?.landlordVerification;
    const verified = verification?.status === "verified";
    const agg = byLandlord.get(u.id) ?? { totalListings: 0, totalApplicants: 0 };
    map.set(u.id, {
      id: u.id,
      name: u.name ?? "Landlord",
      verified,
      verifiedSince:
        verified && verification?.reviewedAt
          ? formatDate(verification.reviewedAt.toISOString())
          : null,
      totalListings: agg.totalListings,
      totalApplicants: agg.totalApplicants,
    });
  }

  for (const id of ids) {
    if (!map.has(id)) map.set(id, unknownSummary(id));
  }

  return map;
}

export async function getLandlordSummary(landlordId) {
  const map = await getLandlordSummaries([landlordId]);
  return map.get(landlordId) ?? unknownSummary(landlordId);
}

// LandlordDocumentItem = { id, type: "utility_bill" | "sublet_agreement", label, fileUrl, createdAt }
// LandlordPublicProfile = LandlordSummary & { completedRentals, avgResponseHours, lastActiveLabel, documents }

/**
 * Extends the base LandlordSummary with the trust signals (completed
 * rentals, avg response time, last-active) and tenant-inspection documents
 * introduced by Landlord Verification & Property Document Management —
 * kept as a separate function so existing LandlordSummary callers (e.g. the
 * agreement page) are unaffected.
 */
export async function getLandlordPublicProfile(landlordUserId) {
  const summary = await getLandlordSummary(landlordUserId);
  const profile = await prisma.profile.findFirst({
    where: { userId: landlordUserId },
    select: { id: true },
  });
  if (!profile) {
    return {
      ...summary,
      completedRentals: 0,
      avgResponseHours: null,
      lastActiveLabel: formatLastActive(null),
      documents: [],
    };
  }

  const [signals, documents] = await Promise.all([
    getLandlordTrustSignals(profile.id, landlordUserId),
    prisma.landlordDocument.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    ...summary,
    completedRentals: signals.completedRentals,
    avgResponseHours: signals.avgResponseHours,
    lastActiveLabel: formatLastActive(signals.lastActiveAt),
    documents: documents.map((d) => ({
      id: d.id,
      type: d.type,
      label: d.label,
      fileUrl: d.fileUrl,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}
