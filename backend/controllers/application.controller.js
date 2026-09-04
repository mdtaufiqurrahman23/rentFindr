import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "../models/prisma.js";
import { getTenantHistorySummaries } from "../services/tenant-history.js";
import { getLandlordSummary } from "../services/landlord-summary.js";

const createSchema = z.object({
  listingId: z.string(),
  note: z.string().optional(),
});

// GET /api/applications?listingId= — a landlord's applicants for one listing.
export async function listApplicationsForListing(req, res) {
  const listingId = req.query.listingId;
  if (!listingId) return res.status(400).json({ error: "listingId is required" });

  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.landlordId !== req.user.id) {
    return res.status(404).json({ error: "Listing not found" });
  }

  const applications = await prisma.application.findMany({
    where: { listingId },
    orderBy: { createdAt: "asc" },
    include: {
      profile: {
        include: { roommatePreference: true, tenantVerification: true },
      },
    },
  });

  const historyByProfile = await getTenantHistorySummaries(applications.map((a) => a.profileId));
  const withHistory = applications.map((a) => ({
    ...a,
    history: historyByProfile.get(a.profileId) ?? null,
  }));

  return res.json(withHistory);
}

export async function createApplication(req, res) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });
  if (user.profile.accountType !== "tenant") {
    return res.status(403).json({
      error: "Only tenant accounts can apply for listings. Sign in with a tenant account.",
    });
  }

  // Fast path: catches the common case with a friendly message before hitting the DB write.
  const existing = await prisma.application.findFirst({
    where: { profileId: user.profile.id, listingId: parsed.data.listingId },
  });
  if (existing) {
    return res.status(409).json({ error: "You have already applied for this listing." });
  }

  // Real guarantee: the findFirst check above isn't atomic with the create below, so two
  // near-simultaneous requests (a double-click, a retried request) can both pass it. The
  // @@unique([profileId, listingId]) DB constraint is what actually prevents the duplicate —
  // this just turns the resulting P2002 violation into the same clean 409 instead of a 500.
  try {
    const application = await prisma.application.create({
      data: {
        profileId: user.profile.id,
        listingId: parsed.data.listingId,
        note: parsed.data.note,
        status: "submitted",
      },
    });
    return res.json(application);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "You have already applied for this listing." });
    }
    throw err;
  }
}

export async function getMyApplications(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });

  const applications = await prisma.application.findMany({
    where: { profileId: user.profile.id },
    orderBy: { createdAt: "desc" },
    include: { listing: { select: { id: true, title: true, area: true } } },
  });

  return res.json(applications);
}

// A landlord's own accepted/completed tenancies across all their listings —
// used by the dispute-filing tenancy picker, which needs this across every
// listing rather than one at a time like GET /api/applications?listingId=.
export async function getLandlordApplications(req, res) {
  const applications = await prisma.application.findMany({
    where: {
      listing: { landlordId: req.user.id },
      status: { in: ["accepted", "completed"] },
    },
    orderBy: { createdAt: "desc" },
    include: {
      listing: { select: { id: true, title: true, area: true } },
      profile: { select: { displayName: true } },
    },
  });

  return res.json(applications);
}

export async function getApplication(req, res) {
  const { applicationId } = req.params;
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { listing: true, profile: true },
  });
  if (!application) return res.status(404).json({ error: "Application not found" });

  const userId = req.user.id;
  const isTenant = application.profile.userId === userId;
  const isLandlord = application.listing.landlordId === userId;
  if (!isTenant && !isLandlord) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (application.status !== "accepted") {
    return res.status(409).json({
      error:
        "This application hasn't been accepted yet — the agreement unlocks once it's accepted.",
    });
  }

  const [landlord, landlordSummary] = await Promise.all([
    prisma.user.findUnique({ where: { id: application.listing.landlordId } }),
    getLandlordSummary(application.listing.landlordId),
  ]);

  return res.json({
    id: application.id,
    tenantName: application.profile.displayName,
    landlordName: landlord?.name ?? "Landlord",
    landlordVerified: landlordSummary.verified,
    landlordVerifiedSince: landlordSummary.verifiedSince,
    listing: {
      id: application.listing.id,
      title: application.listing.title,
      roomType: application.listing.roomType,
      area: application.listing.area,
      city: application.listing.city,
      latitude: application.listing.latitude,
      longitude: application.listing.longitude,
      rent: application.listing.rent,
      deposit: application.listing.deposit,
      availableFrom: application.listing.availableFrom.toISOString(),
      landlordId: application.listing.landlordId,
      houseRules: application.listing.houseRules,
    },
  });
}

const updateStatusSchema = z.object({
  status: z.enum(["shortlisted", "accepted", "declined", "completed"]),
});

export async function updateApplicationStatus(req, res) {
  const { applicationId } = req.params;
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { listing: true },
  });
  if (!application) return res.status(404).json({ error: "Application not found" });
  if (application.listing.landlordId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid status" });

  const updated = await prisma.application.update({
    where: { id: applicationId },
    data: { status: parsed.data.status },
  });

  return res.json(updated);
}
