import { prisma } from "../models/prisma.js";
import { computeLeaseTimeline } from "./lease-timeline-shared.js";

// TenantLeaseTimelineItem = LeaseTimeline & { applicationId, listingId, listingTitle }

/**
 * One entry per active, fully-signed tenancy for this tenant. Almost always
 * a single entry, but not assumed to be — nothing stops a tenant profile
 * from holding more than one accepted tenancy at once.
 */
export async function getTenantLeaseTimelines(profileId) {
  const drafts = await prisma.agreementDraft.findMany({
    where: { profileId, tenantSignature: { not: null }, landlordSignature: { not: null } },
  });

  const items = [];
  for (const draft of drafts) {
    const listingId = draft.reference.split("/")[0];
    if (!listingId) continue;
    const terms = draft.termsJson;
    if (!terms?.durationMonths) continue;

    const [listing, application] = await Promise.all([
      prisma.listing.findUnique({ where: { id: listingId } }),
      prisma.application.findUnique({ where: { profileId_listingId: { profileId, listingId } } }),
    ]);
    if (!listing || !application || application.status !== "accepted") continue;

    items.push({
      applicationId: application.id,
      listingId,
      listingTitle: listing.title,
      ...computeLeaseTimeline(listing.availableFrom, terms.durationMonths),
    });
  }
  return items;
}

// LandlordLeaseTimelineItem = TenantLeaseTimelineItem & { tenantName, renewalWindowMonthLabel }

/**
 * One entry per (listing, tenant) pair — not per listing — since a shared
 * listing (a mess room) can have multiple accepted tenants simultaneously,
 * each on their own signed agreement with their own term length. Sorted by
 * soonest expiry first: the most time-sensitive thing for a landlord to act
 * on, portfolio-wide.
 */
export async function getLandlordLeaseTimelines(landlordUserId) {
  const listings = await prisma.listing.findMany({ where: { landlordId: landlordUserId } });
  const items = [];

  for (const listing of listings) {
    const acceptedApplications = await prisma.application.findMany({
      where: { listingId: listing.id, status: "accepted" },
      include: { profile: true },
    });

    for (const application of acceptedApplications) {
      const draft = await prisma.agreementDraft.findFirst({
        where: {
          profileId: application.profileId,
          reference: { startsWith: `${listing.id}/` },
          tenantSignature: { not: null },
          landlordSignature: { not: null },
        },
        orderBy: { createdAt: "desc" },
      });
      if (!draft) continue;
      const terms = draft.termsJson;
      if (!terms?.durationMonths) continue;

      const timeline = computeLeaseTimeline(listing.availableFrom, terms.durationMonths);
      items.push({
        applicationId: application.id,
        listingId: listing.id,
        listingTitle: listing.title,
        tenantName: application.profile.displayName,
        renewalWindowMonthLabel: new Date(timeline.renewalWindowStart).toLocaleString("en-US", {
          month: "long",
          year: "numeric",
        }),
        ...timeline,
      });
    }
  }

  return items.sort((a, b) => a.daysRemaining - b.daysRemaining);
}
