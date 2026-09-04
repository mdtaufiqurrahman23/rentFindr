import { z } from "zod";
import { prisma } from "../models/prisma.js";
import { logActivity } from "../services/activity.js";
import { recomputeSettlement } from "../services/move-out.js";

const MAX_PHOTO_CHARS = 2_200_000; // same cap used elsewhere for base64 photo uploads

const createSchema = z.object({
  applicationId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  amount: z.number().int().positive(),
  photoUrl: z.string().max(MAX_PHOTO_CHARS).optional(),
  settlementMethod: z.enum(["deduct_from_deposit", "deduct_from_rent", "reimburse_separately"]),
});

export async function getImprovementCosts(req, res) {
  const applicationId = req.query.applicationId;
  if (!applicationId) {
    return res.status(400).json({ error: "applicationId is required" });
  }

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

  const costs = await prisma.improvementCost.findMany({
    where: { applicationId },
    orderBy: { createdAt: "desc" },
  });
  return res.json(costs);
}

export async function createImprovementCost(req, res) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid improvement cost entry" });
  }

  const application = await prisma.application.findUnique({
    where: { id: parsed.data.applicationId },
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
    return res
      .status(409)
      .json({ error: "You can only log improvement costs for an active tenancy." });
  }

  const loggedByProfileId = isTenant
    ? application.profileId
    : (await prisma.profile.findUnique({ where: { userId } }))?.id;
  if (!loggedByProfileId) return res.status(404).json({ error: "Profile not found" });

  const created = await prisma.improvementCost.create({
    data: {
      applicationId: application.id,
      loggedByProfileId,
      loggedByRole: isTenant ? "tenant" : "landlord",
      title: parsed.data.title,
      description: parsed.data.description,
      amount: parsed.data.amount,
      photoUrl: parsed.data.photoUrl,
      settlementMethod: parsed.data.settlementMethod,
    },
  });

  await logActivity({
    listingId: application.listingId,
    tenantProfileId: application.profileId,
    type: "improvement_cost_logged",
    actor: isTenant ? "tenant" : "landlord",
    summary: `${isTenant ? "Tenant" : "Landlord"} logged an improvement cost of ৳${parsed.data.amount.toLocaleString("en-BD")} — "${parsed.data.title}" (awaiting approval).`,
  });

  return res.status(201).json(created);
}

const patchSchema = z.object({ action: z.enum(["approve", "reject"]) });

export async function decideImprovementCost(req, res) {
  const { costId } = req.params;
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const cost = await prisma.improvementCost.findUnique({
    where: { id: costId },
    include: { application: { include: { listing: true, profile: true, moveOut: true } } },
  });
  if (!cost) return res.status(404).json({ error: "Improvement cost not found" });

  const userId = req.user.id;
  const isTenant = cost.application.profile.userId === userId;
  const isLandlord = cost.application.listing.landlordId === userId;
  if (!isTenant && !isLandlord) return res.status(403).json({ error: "Forbidden" });

  // Only the party that DIDN'T log it can decide — logging your own cost and
  // immediately approving it would defeat the entire point of the workflow.
  const deciderRole = isTenant ? "tenant" : "landlord";
  if (deciderRole === cost.loggedByRole) {
    return res.status(403).json({
      error: "The party who logged this cost can't also approve or reject it.",
    });
  }
  if (cost.status !== "pending") {
    return res.status(409).json({ error: "This entry has already been decided." });
  }

  const deciderProfileId = isTenant
    ? cost.application.profileId
    : (await prisma.profile.findUnique({ where: { userId } }))?.id;
  if (!deciderProfileId) return res.status(404).json({ error: "Profile not found" });

  const newStatus = parsed.data.action === "approve" ? "approved" : "rejected";
  const updated = await prisma.improvementCost.update({
    where: { id: costId },
    data: { status: newStatus, decidedByProfileId: deciderProfileId, decidedAt: new Date() },
  });

  await logActivity({
    listingId: cost.application.listingId,
    tenantProfileId: cost.application.profileId,
    type: newStatus === "approved" ? "improvement_cost_approved" : "improvement_cost_rejected",
    actor: deciderRole,
    summary: `${deciderRole === "tenant" ? "Tenant" : "Landlord"} ${newStatus} an improvement cost of ৳${cost.amount.toLocaleString("en-BD")} — "${cost.title}".`,
  });

  // If a move-out is already in progress, the settlement figures the parties
  // are looking at just changed — recompute immediately (set_deductions does
  // the same thing) rather than leaving a stale preview until something else
  // happens to trigger a recompute.
  if (newStatus === "approved" && cost.application.moveOut) {
    await recomputeSettlement(cost.application.moveOut.id);
    if (
      cost.application.moveOut.landlordConfirmedAt ||
      cost.application.moveOut.tenantConfirmedAt
    ) {
      await prisma.moveOut.update({
        where: { id: cost.application.moveOut.id },
        data: { landlordConfirmedAt: null, tenantConfirmedAt: null },
      });
    }
  }

  return res.json(updated);
}
