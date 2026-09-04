import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "../models/prisma.js";
import { verificationApprovedEmail, verificationRejectedEmail } from "../services/gmail.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches ShareLink's window

function generateCode() {
  const raw = randomBytes(5).toString("hex").toUpperCase(); // 10 hex chars
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export async function createAdminInvite(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });

  const invite = await prisma.adminInvite.create({
    data: {
      code: generateCode(),
      createdById: user.profile.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  const baseUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
  return res.json({
    code: invite.code,
    url: `${baseUrl}/auth?adminInvite=${encodeURIComponent(invite.code)}`,
    expiresAt: invite.expiresAt,
  });
}

export async function listAdminInvites(req, res) {
  const invites = await prisma.adminInvite.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { createdBy: { select: { displayName: true } } },
  });

  return res.json(invites);
}

export async function listLandlordVerifications(req, res) {
  const verifications = await prisma.landlordVerification.findMany({
    include: {
      profile: {
        include: { user: { select: { email: true } } },
      },
    },
    orderBy: [{ status: "asc" }, { submittedAt: "asc" }],
  });

  return res.json(verifications);
}

const reviewSchema = z.object({
  status: z.enum(["verified", "rejected"]),
  reviewNote: z.string().max(500).optional(),
});

export async function reviewLandlordVerification(req, res) {
  const { verificationId } = req.params;
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const existing = await prisma.landlordVerification.findUnique({
    where: { id: verificationId },
    include: { profile: { include: { user: { select: { email: true, name: true } } } } },
  });
  if (!existing) return res.status(404).json({ error: "Verification not found" });

  const updated = await prisma.landlordVerification.update({
    where: { id: verificationId },
    data: {
      status: parsed.data.status,
      reviewNote: parsed.data.reviewNote,
      reviewedAt: new Date(),
    },
  });

  // Approval alone doesn't make prior Draft listings public — without this they'd
  // silently stay Draft forever until the landlord manually re-opens and re-saves
  // each one. Promoting them here is what "your account is now verified" implies.
  if (parsed.data.status === "verified") {
    await prisma.listing.updateMany({
      where: { landlordId: existing.profile.userId, status: "Draft" },
      data: { status: "Active" },
    });
  }

  const recipientEmail = existing.profile.user.email;
  const recipientName = existing.profile.user.name ?? existing.profile.displayName;
  if (parsed.data.status === "verified") {
    await verificationApprovedEmail(recipientEmail, recipientName, "landlord");
  } else {
    await verificationRejectedEmail(
      recipientEmail,
      recipientName,
      "landlord",
      parsed.data.reviewNote,
    );
  }

  return res.json(updated);
}

export async function listTenantVerifications(req, res) {
  const verifications = await prisma.tenantVerification.findMany({
    include: {
      profile: {
        include: { user: { select: { email: true } } },
      },
    },
    orderBy: [{ status: "asc" }, { submittedAt: "asc" }],
  });

  return res.json(verifications);
}

export async function reviewTenantVerification(req, res) {
  const { verificationId } = req.params;
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const existing = await prisma.tenantVerification.findUnique({
    where: { id: verificationId },
    include: { profile: { include: { user: { select: { email: true, name: true } } } } },
  });
  if (!existing) return res.status(404).json({ error: "Verification not found" });

  const updated = await prisma.tenantVerification.update({
    where: { id: verificationId },
    data: {
      status: parsed.data.status,
      reviewNote: parsed.data.reviewNote,
      reviewedAt: new Date(),
    },
  });

  const recipientEmail = existing.profile.user.email;
  const recipientName = existing.profile.user.name ?? existing.profile.displayName;
  if (parsed.data.status === "verified") {
    await verificationApprovedEmail(recipientEmail, recipientName, "tenant");
  } else {
    await verificationRejectedEmail(
      recipientEmail,
      recipientName,
      "tenant",
      parsed.data.reviewNote,
    );
  }

  return res.json(updated);
}
