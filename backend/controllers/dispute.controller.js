import { z } from "zod";

import { prisma } from "../models/prisma.js";
import { buildEvidenceBundle, generateDisputeAnalysis } from "../services/dispute.js";
import { logActivity } from "../services/activity.js";
import {
  disputeFiledConfirmationEmail,
  disputeNotificationEmail,
  disputeResolvedEmail,
} from "../services/gmail.js";

const createSchema = z.object({
  applicationId: z.string().min(1),
  type: z.enum(["unlawful_eviction", "unpaid_deposit", "property_damage", "other"]),
  description: z.string().min(1),
});

// Admin-only: every open/resolved dispute across the platform.
export async function listAllDisputes(req, res) {
  const disputes = await prisma.dispute.findMany({
    // Open first, then newest — an admin queue, not a chronological log.
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      filedBy: { select: { displayName: true } },
      application: { include: { listing: { select: { id: true, title: true } } } },
    },
  });

  return res.json(
    disputes.map((d) => ({
      id: d.id,
      type: d.type,
      status: d.status,
      createdAt: d.createdAt,
      filedByRole: d.filedByRole,
      filedByName: d.filedBy.displayName,
      listingTitle: d.application.listing.title,
    })),
  );
}

export async function createDispute(req, res) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid dispute payload" });
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
  if (application.status !== "accepted" && application.status !== "completed") {
    return res
      .status(409)
      .json({ error: "Disputes can only be filed on an active or completed tenancy." });
  }

  const filerUser = await prisma.user.findUnique({ where: { id: userId } });
  const filerProfileId = isTenant
    ? application.profileId
    : (await prisma.profile.findUnique({ where: { userId } }))?.id;
  if (!filerProfileId) {
    return res.status(404).json({ error: "Profile not found" });
  }

  const bundle = await buildEvidenceBundle(application.id);
  const analysis = await generateDisputeAnalysis(
    bundle,
    parsed.data.type,
    parsed.data.description,
    isTenant ? "tenant" : "landlord",
  );

  const dispute = await prisma.dispute.create({
    data: {
      applicationId: application.id,
      filedByProfileId: filerProfileId,
      filedByRole: isTenant ? "tenant" : "landlord",
      type: parsed.data.type,
      description: parsed.data.description,
      evidenceJson: bundle,
      aiSummary: analysis.summary,
      aiInconsistencies: analysis.inconsistencies,
      aiSuggestedSplit: analysis.suggestedSplit,
      aiSource: analysis.source,
    },
  });

  await logActivity({
    listingId: application.listingId,
    tenantProfileId: application.profileId,
    type: "dispute_filed",
    actor: isTenant ? "tenant" : "landlord",
    summary: `${isTenant ? "Tenant" : "Landlord"} filed a dispute (${parsed.data.type.replace(/_/g, " ")}) — Ref ${dispute.id}.`,
  });

  const [landlordUser, tenantUser] = await Promise.all([
    prisma.user.findUnique({ where: { id: application.listing.landlordId } }),
    prisma.user.findUnique({ where: { id: application.profile.userId } }),
  ]);
  const filerEmail = filerUser?.email;
  const filerName = isTenant ? application.profile.displayName : (landlordUser?.name ?? "Landlord");
  const counterpartyEmail = isTenant ? landlordUser?.email : tenantUser?.email;
  const counterpartyName = isTenant
    ? (landlordUser?.name ?? "Landlord")
    : application.profile.displayName;

  if (filerEmail) {
    await disputeFiledConfirmationEmail(filerEmail, filerName, dispute.id).catch(() => {});
  }
  if (counterpartyEmail && counterpartyEmail !== filerEmail) {
    await disputeNotificationEmail(counterpartyEmail, counterpartyName, dispute.id).catch(() => {});
  }

  return res.status(201).json({ id: dispute.id, status: dispute.status });
}

// Disputes where the caller is either the filer or the counterparty
// (tenant on the application, or landlord of the listing it's against).
export async function getMyDisputes(req, res) {
  const userId = req.user.id;
  const profile = await prisma.profile.findUnique({ where: { userId } });

  const disputes = await prisma.dispute.findMany({
    where: {
      OR: [
        ...(profile ? [{ filedByProfileId: profile.id }] : []),
        ...(profile ? [{ application: { profileId: profile.id } }] : []),
        { application: { listing: { landlordId: userId } } },
      ],
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      filedBy: { select: { displayName: true } },
      application: { include: { listing: { select: { id: true, title: true } } } },
    },
  });

  return res.json(
    disputes.map((d) => ({
      id: d.id,
      type: d.type,
      status: d.status,
      createdAt: d.createdAt,
      filedByRole: d.filedByRole,
      filedByName: d.filedBy.displayName,
      listingTitle: d.application.listing.title,
    })),
  );
}

async function loadWithAccess(disputeId, userId, role) {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: {
      filedBy: { select: { displayName: true } },
      application: { include: { listing: true, profile: true } },
    },
  });
  if (!dispute) return { dispute: null, allowed: false };

  const isAdmin = role === "ADMIN";
  const isTenant = dispute.application.profile.userId === userId;
  const isLandlord = dispute.application.listing.landlordId === userId;
  return { dispute, allowed: isAdmin || isTenant || isLandlord, isAdmin };
}

// GET is open to any authenticated party (tenant, landlord, or admin) — only
// PATCH (issuing the resolution) is admin-gated, per the original route.ts.
export async function getDispute(req, res) {
  const { disputeId } = req.params;
  const { dispute, allowed, isAdmin } = await loadWithAccess(disputeId, req.user.id, req.user.role);
  if (!dispute) return res.status(404).json({ error: "Dispute not found" });
  if (!allowed) return res.status(403).json({ error: "Forbidden" });

  return res.json({
    id: dispute.id,
    type: dispute.type,
    status: dispute.status,
    description: dispute.description,
    filedByRole: dispute.filedByRole,
    filedByName: dispute.filedBy.displayName,
    createdAt: dispute.createdAt,
    resolvedAt: dispute.resolvedAt,
    resolution: dispute.resolution,
    evidence: dispute.evidenceJson,
    aiSummary: dispute.aiSummary,
    aiInconsistencies: dispute.aiInconsistencies,
    aiSuggestedSplit: dispute.aiSuggestedSplit,
    aiSource: dispute.aiSource,
    canResolve: isAdmin && dispute.status === "open",
  });
}

const resolveSchema = z.object({
  resolution: z.string().min(1),
});

// Admin-only: issues the final, binding written resolution.
export async function resolveDispute(req, res) {
  const { disputeId } = req.params;
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A resolution is required." });

  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: { application: { include: { listing: true, profile: true } } },
  });
  if (!dispute) return res.status(404).json({ error: "Dispute not found" });
  if (dispute.status === "resolved") {
    return res.status(409).json({ error: "This dispute has already been resolved." });
  }

  // Conditional on status: "open" in the WHERE clause, not just checked above —
  // the read-then-write above has a race window where two concurrent PATCH
  // requests (a double-click, two admins) can both pass that check. Only the
  // first write here actually matches a row; the second gets count 0 and 409s
  // instead of silently overwriting the first admin's resolution.
  const { count } = await prisma.dispute.updateMany({
    where: { id: disputeId, status: "open" },
    data: {
      status: "resolved",
      resolution: parsed.data.resolution,
      resolvedByUserId: req.user.id,
      resolvedAt: new Date(),
    },
  });
  if (count === 0) {
    return res.status(409).json({ error: "This dispute has already been resolved." });
  }
  const updated = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });

  await logActivity({
    listingId: dispute.application.listingId,
    tenantProfileId: dispute.application.profileId,
    type: "dispute_resolved",
    actor: "system",
    summary: `Admin issued a resolution for dispute Ref ${dispute.id}.`,
  });

  const [landlordUser, tenantUser] = await Promise.all([
    prisma.user.findUnique({ where: { id: dispute.application.listing.landlordId } }),
    prisma.user.findUnique({ where: { id: dispute.application.profile.userId } }),
  ]);
  if (tenantUser?.email) {
    await disputeResolvedEmail(
      tenantUser.email,
      dispute.application.profile.displayName,
      dispute.id,
      parsed.data.resolution,
    ).catch(() => {});
  }
  if (landlordUser?.email) {
    await disputeResolvedEmail(
      landlordUser.email,
      landlordUser.name ?? "Landlord",
      dispute.id,
      parsed.data.resolution,
    ).catch(() => {});
  }

  return res.json({ id: updated.id, status: updated.status });
}
