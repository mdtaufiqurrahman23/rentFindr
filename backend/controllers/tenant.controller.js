import { z } from "zod";
import { prisma } from "../models/prisma.js";

const MAX_PHOTO_CHARS = 2_200_000; // ~1.6MB raw, base64-inflated

const submitSchema = z.object({
  nidNumber: z.string().min(5).max(30),
  phone: z.string().min(6).max(20),
  nidPhoto: z.string().min(1).max(MAX_PHOTO_CHARS),
});

export async function getTenantVerification(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: { include: { tenantVerification: true } } },
  });

  return res.json({
    status: user?.profile?.tenantVerification?.status ?? null,
    reviewNote: user?.profile?.tenantVerification?.reviewNote ?? null,
  });
}

export async function submitTenantVerification(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: { include: { tenantVerification: true } } },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found." });

  if (user.profile.tenantVerification && user.profile.tenantVerification.status !== "rejected") {
    return res.status(409).json({
      error: "You already have a verification on file — it's pending review or already verified.",
    });
  }

  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Provide an NID number, phone number, and a photo of your NID." });
  }

  const verification = await prisma.tenantVerification.upsert({
    where: { profileId: user.profile.id },
    create: {
      profileId: user.profile.id,
      nidNumber: parsed.data.nidNumber,
      phone: parsed.data.phone,
      nidPhotoUrl: parsed.data.nidPhoto,
      status: "pending",
    },
    update: {
      nidNumber: parsed.data.nidNumber,
      phone: parsed.data.phone,
      nidPhotoUrl: parsed.data.nidPhoto,
      status: "pending",
      reviewNote: null,
      reviewedAt: null,
    },
  });

  return res.status(201).json(verification);
}
