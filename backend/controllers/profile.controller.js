import { z } from "zod";
import { prisma } from "../models/prisma.js";
import { getTenantHistory } from "../services/tenant-history.js";
import { getTenantTrustSignals } from "../services/trust-signals.js";
import { getTenantLeaseTimelines } from "../services/lease-timeline.js";

// Aggregates everything the profile page needs into one response — this
// replaces the direct Prisma calls that used to run inside the Next.js
// server component itself (src/app/profile/page.tsx), since the frontend
// no longer has DB access.
export async function getMyProfile(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: { include: { tenantVerification: true } } },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });

  const profile = user.profile;

  const [
    savedListingsCount,
    applications,
    roommateSessions,
    agreementDrafts,
    reviewsReceived,
    history,
    leaseTimelines,
  ] = await Promise.all([
    prisma.savedListing.count({ where: { profileId: profile.id } }),
    prisma.application.findMany({
      where: { profileId: profile.id },
      include: { listing: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.roommateSession.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: "desc" },
    }),
    prisma.agreementDraft.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: "desc" },
    }),
    prisma.review.findMany({
      where: { application: { profileId: profile.id }, raterProfileId: { not: profile.id } },
      include: { application: { include: { listing: { select: { title: true } } } } },
      orderBy: { createdAt: "desc" },
    }),
    getTenantHistory(profile.id),
    getTenantLeaseTimelines(profile.id),
  ]);

  const trustSignals =
    profile.accountType === "tenant" ? await getTenantTrustSignals(profile.id) : null;

  const acceptedListingIds = applications
    .filter((a) => a.status === "accepted")
    .map((a) => a.listingId);
  const activityEvents = acceptedListingIds.length
    ? await prisma.activityEvent.findMany({
        where: { tenantProfileId: profile.id, listingId: { in: acceptedListingIds } },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const activityByListing = {};
  for (const event of activityEvents) {
    (activityByListing[event.listingId] ??= []).push(event);
  }

  return res.json({
    user: { id: user.id, email: user.email, role: user.role },
    profile,
    savedListingsCount,
    applications,
    roommateSessions,
    agreementDrafts,
    reviewsReceived,
    history,
    leaseTimelines,
    trustSignals,
    activityByListing,
  });
}

const deleteSchema = z.object({
  type: z.enum(["savedListing", "application", "roommateSession", "agreementDraft"]),
  id: z.string(),
});

export async function deleteProfileItem(req, res) {
  const parsed = deleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });

  const profileId = user.profile.id;
  const { type, id } = parsed.data;

  const result =
    type === "savedListing"
      ? await prisma.savedListing.deleteMany({ where: { id, profileId } })
      : type === "application"
        ? await prisma.application.deleteMany({ where: { id, profileId } })
        : type === "roommateSession"
          ? await prisma.roommateSession.deleteMany({ where: { id, profileId } })
          : await prisma.agreementDraft.deleteMany({ where: { id, profileId } });

  if (result.count === 0) return res.status(404).json({ error: "Not found" });

  return res.json({ ok: true });
}
