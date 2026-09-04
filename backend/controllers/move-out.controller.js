import { z } from "zod";
import { prisma } from "../models/prisma.js";
import { logActivity } from "../services/activity.js";
import {
  recomputeSettlement,
  finalizeMoveOut,
  escalateMoveOutToDispute,
} from "../services/move-out.js";
import { getApprovedImprovementCostAdjustment } from "../services/improvement-cost.js";
import { moveOutProposedEmail } from "../services/gmail.js";

const createSchema = z.object({
  applicationId: z.string().min(1),
  proposedEndDate: z.string().min(1),
});

export async function createMoveOut(req, res) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid move-out request" });

  const endDate = new Date(parsed.data.proposedEndDate);
  if (Number.isNaN(endDate.getTime())) {
    return res.status(400).json({ error: "Invalid end date" });
  }

  const application = await prisma.application.findUnique({
    where: { id: parsed.data.applicationId },
    include: { listing: true, moveOut: true, profile: { include: { user: true } } },
  });
  if (!application) return res.status(404).json({ error: "Application not found" });
  if (application.listing.landlordId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (application.status !== "accepted") {
    return res.status(409).json({
      error: "A move-out can only be initiated for an active tenancy.",
    });
  }
  if (application.moveOut) {
    return res.status(409).json({
      error: "A move-out has already been initiated for this tenancy.",
    });
  }

  const created = await prisma.moveOut.create({
    data: {
      applicationId: application.id,
      proposedEndDate: endDate,
      depositAmount: application.listing.deposit,
    },
  });
  await recomputeSettlement(created.id);

  const endDateLabel = endDate.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  await logActivity({
    listingId: application.listingId,
    tenantProfileId: application.profileId,
    type: "move_out_proposed",
    actor: "landlord",
    summary: `Landlord proposed a move-out date of ${endDateLabel}.`,
  });

  if (application.profile.user.email) {
    await moveOutProposedEmail(
      application.profile.user.email,
      application.profile.displayName,
      application.listing.title,
      endDateLabel,
    ).catch(() => {});
  }

  return res.status(201).json({ id: created.id, status: created.status });
}

const MAX_DEDUCTIONS = 20;
const MAX_PHOTO_CHARS = 2_200_000; // same cap used elsewhere for base64 photo uploads

const deductionSchema = z.object({
  description: z.string().min(1).max(200),
  amount: z.number().int().nonnegative(),
  photoUrl: z.string().max(MAX_PHOTO_CHARS).optional(),
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("acknowledge") }),
  z.object({
    action: z.literal("set_deductions"),
    deductions: z.array(deductionSchema).max(MAX_DEDUCTIONS),
  }),
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("dispute"), description: z.string().min(1) }),
]);

async function loadWithAccess(applicationId, userId) {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { listing: true, profile: true, moveOut: true },
  });
  if (!application) return { application: null, isTenant: false, isLandlord: false };
  return {
    application,
    isTenant: application.profile.userId === userId,
    isLandlord: application.listing.landlordId === userId,
  };
}

export async function getMoveOut(req, res) {
  const { applicationId } = req.params;
  const { application, isTenant, isLandlord } = await loadWithAccess(applicationId, req.user.id);
  if (!application) return res.status(404).json({ error: "Application not found" });
  if (!isTenant && !isLandlord) return res.status(403).json({ error: "Forbidden" });
  if (!application.moveOut) return res.json(null);

  const improvementAdjustment = await getApprovedImprovementCostAdjustment(applicationId);

  return res.json({
    ...application.moveOut,
    improvementAdjustment,
    isTenant,
    isLandlord,
  });
}

export async function updateMoveOut(req, res) {
  const { applicationId } = req.params;
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const { application, isTenant, isLandlord } = await loadWithAccess(applicationId, req.user.id);
  if (!application) return res.status(404).json({ error: "Application not found" });
  if (!application.moveOut) return res.status(404).json({ error: "No move-out on file" });
  const moveOut = application.moveOut;

  if (parsed.data.action === "acknowledge") {
    if (!isTenant) return res.status(403).json({ error: "Forbidden" });
    if (moveOut.status !== "proposed") {
      return res.status(409).json({ error: "This move-out has already been acknowledged." });
    }
    await prisma.moveOut.update({
      where: { id: moveOut.id },
      data: { status: "acknowledged", tenantAcknowledgedAt: new Date() },
    });
    await logActivity({
      listingId: application.listingId,
      tenantProfileId: application.profileId,
      type: "move_out_acknowledged",
      actor: "tenant",
      summary: "Tenant acknowledged the proposed move-out date.",
    });
    return res.json({ ok: true });
  }

  if (parsed.data.action === "set_deductions") {
    if (!isLandlord) return res.status(403).json({ error: "Forbidden" });
    if (moveOut.status !== "acknowledged") {
      return res.status(409).json({
        error: "Deductions can only be set once the tenant has acknowledged the move-out.",
      });
    }
    // Changing the numbers after either party already confirmed would let a
    // confirmation apply to different figures than what was actually agreed
    // to — clear both and require re-confirmation instead.
    await prisma.moveOut.update({
      where: { id: moveOut.id },
      data: {
        deductionsJson: parsed.data.deductions,
        landlordConfirmedAt: null,
        tenantConfirmedAt: null,
      },
    });
    await recomputeSettlement(moveOut.id);
    await logActivity({
      listingId: application.listingId,
      tenantProfileId: application.profileId,
      type: "move_out_deductions_set",
      actor: "landlord",
      summary: `Landlord itemized ${parsed.data.deductions.length} deduction${parsed.data.deductions.length === 1 ? "" : "s"} against the deposit.`,
    });
    return res.json({ ok: true });
  }

  if (parsed.data.action === "confirm") {
    if (!isTenant && !isLandlord) return res.status(403).json({ error: "Forbidden" });
    if (moveOut.status !== "acknowledged") {
      return res.status(409).json({ error: "The move-out isn't ready to confirm yet." });
    }
    const now = new Date();
    const updated = await prisma.moveOut.update({
      where: { id: moveOut.id },
      data: isTenant ? { tenantConfirmedAt: now } : { landlordConfirmedAt: now },
    });
    await logActivity({
      listingId: application.listingId,
      tenantProfileId: application.profileId,
      type: "move_out_confirmed",
      actor: isTenant ? "tenant" : "landlord",
      summary: `${isTenant ? "Tenant" : "Landlord"} confirmed the settlement.`,
    });

    if (updated.tenantConfirmedAt && updated.landlordConfirmedAt) {
      await finalizeMoveOut(moveOut.id);
      return res.json({ ok: true, settled: true });
    }
    return res.json({ ok: true, settled: false });
  }

  // action === "dispute"
  if (!isTenant) return res.status(403).json({ error: "Forbidden" });
  if (moveOut.status !== "acknowledged") {
    return res.status(409).json({
      error: "There's nothing to dispute yet — wait for the settlement figures.",
    });
  }
  const dispute = await escalateMoveOutToDispute(moveOut.id, parsed.data.description);
  return res.json({ ok: true, disputeId: dispute.id });
}
