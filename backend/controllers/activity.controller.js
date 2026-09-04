import { prisma } from "../models/prisma.js";

// Read-only on purpose — there is no PATCH/DELETE here. Events are only ever
// written by server-side actions (see services/activity.js), never by a
// client, which is what keeps this timeline tamper-evident.
export async function listActivityEvents(req, res) {
  const { listingId, tenantProfileId } = req.query;
  if (!listingId || !tenantProfileId) {
    return res.status(400).json({ error: "listingId and tenantProfileId are required" });
  }

  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) return res.status(404).json({ error: "Listing not found" });

  const userId = req.user.id;
  const tenantProfile = await prisma.profile.findUnique({ where: { id: tenantProfileId } });
  const isTenant = tenantProfile?.userId === userId;
  const isLandlord = listing.landlordId === userId;
  if (!isTenant && !isLandlord) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const events = await prisma.activityEvent.findMany({
    where: { listingId, tenantProfileId },
    orderBy: { createdAt: "asc" },
  });

  return res.json(events);
}

export async function pingActivity(req, res) {
  await prisma.profile.updateMany({
    where: { userId: req.user.id },
    data: { lastActiveAt: new Date() },
  });

  return res.json({ ok: true });
}
