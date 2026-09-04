import { z } from "zod";
import { prisma } from "../models/prisma.js";
import { getLandlordTrustSignals } from "../services/trust-signals.js";

const MAX_FILE_CHARS = 2_200_000; // ~1.6MB raw, base64-inflated — matches the register/listing-photo convention

const createDocumentSchema = z.object({
  type: z.enum(["utility_bill", "sublet_agreement"]),
  label: z.string().min(1).max(120),
  fileUrl: z.string().min(1).max(MAX_FILE_CHARS),
});

export async function listLandlordDocuments(req, res) {
  const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } });
  if (!profile) return res.status(404).json({ error: "No profile found" });

  const documents = await prisma.landlordDocument.findMany({
    where: { profileId: profile.id },
    orderBy: { createdAt: "desc" },
  });
  return res.json(documents);
}

export async function createLandlordDocument(req, res) {
  const parsed = createDocumentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const profile = await prisma.profile.findUnique({
    where: { userId: req.user.id },
    include: { landlordVerification: true },
  });
  if (!profile) return res.status(404).json({ error: "No profile found" });
  if (profile.landlordVerification?.status !== "verified") {
    return res
      .status(403)
      .json({ error: "Only verified landlords can upload documents for tenant inspection." });
  }

  const document = await prisma.landlordDocument.create({
    data: {
      profileId: profile.id,
      type: parsed.data.type,
      label: parsed.data.label,
      fileUrl: parsed.data.fileUrl,
    },
  });
  return res.json(document);
}

export async function deleteLandlordDocument(req, res) {
  const { documentId } = req.params;
  const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } });
  if (!profile) return res.status(404).json({ error: "No profile found" });

  const existing = await prisma.landlordDocument.findUnique({ where: { id: documentId } });
  if (!existing || existing.profileId !== profile.id) {
    return res.status(404).json({ error: "Document not found" });
  }

  await prisma.landlordDocument.delete({ where: { id: documentId } });
  return res.json({ ok: true });
}

export async function getLandlordTrustSignalsHandler(req, res) {
  const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } });
  if (!profile) return res.status(404).json({ error: "No profile found" });

  const signals = await getLandlordTrustSignals(profile.id, req.user.id);
  return res.json(signals);
}

export async function getLandlordVerification(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: { include: { landlordVerification: true } } },
  });

  const v = user?.profile?.landlordVerification;
  return res.json({
    status: v?.status ?? null,
    reviewNote: v?.reviewNote ?? null,
    nidPhotoUrl: v?.nidPhotoUrl ?? null,
    ownershipProofUrl: v?.ownershipProofUrl ?? null,
    selfiePhotoUrl: v?.selfiePhotoUrl ?? null,
  });
}
