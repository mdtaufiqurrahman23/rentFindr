import { z } from "zod";
import { prisma } from "../models/prisma.js";
import { logActivity } from "../services/activity.js";
import { draftAgreementClauses, agreementTermsSchema } from "../services/agreement.js";
import { agreementDeliveryEmail } from "../services/gmail.js";

export async function draftAgreement(req, res) {
  const parsed = agreementTermsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid agreement terms." });
  }

  const result = await draftAgreementClauses(parsed.data);
  return res.json(result);
}

const saveSchema = z.object({
  reference: z.string(),
  // Full shape validation (not z.record(z.unknown())) so a malformed save
  // can never persist data that later crashes the public /share page, which
  // reads numeric fields like rent/deposit straight out of this JSON.
  termsJson: agreementTermsSchema,
  clausesJson: z.array(z.object({ title: z.string(), body: z.string() })),
  source: z.string(),
});

export async function saveAgreement(req, res) {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });

  // Upsert by the (profileId, reference) unique constraint so regenerating
  // always replaces the same row atomically, instead of racing a findFirst
  // against a concurrent request and possibly creating a duplicate row.
  const draft = await prisma.agreementDraft.upsert({
    where: {
      profileId_reference: { profileId: user.profile.id, reference: parsed.data.reference },
    },
    update: {
      clausesJson: parsed.data.clausesJson,
      source: parsed.data.source,
      termsJson: parsed.data.termsJson,
    },
    create: {
      profileId: user.profile.id,
      reference: parsed.data.reference,
      termsJson: parsed.data.termsJson,
      clausesJson: parsed.data.clausesJson,
      source: parsed.data.source,
    },
  });

  return res.json({ id: draft.id });
}

const DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
const MAX_SIGNATURE_LENGTH = 300_000; // ~220KB decoded, plenty for a signature PNG

const signSchema = z.object({
  draftId: z.string().min(1),
  role: z.enum(["tenant", "landlord"]),
  signature: z
    .string()
    .min(1)
    .max(MAX_SIGNATURE_LENGTH)
    .regex(DATA_URL_RE, "Invalid signature image"),
});

export async function signAgreement(req, res) {
  const parsed = signSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid payload" });
  }

  const draft = await prisma.agreementDraft.findUnique({
    where: { id: parsed.data.draftId },
    include: { profile: true },
  });
  if (!draft) return res.status(404).json({ error: "Draft not found" });

  // reference is always `${listingId}/${duration}M` (see agreement/page.tsx) — reused
  // below both to authorize the signer and to scope the activity-log entry.
  const userId = req.user.id;
  const listingId = draft.reference.split("/")[0];

  if (parsed.data.role === "tenant") {
    if (draft.profile.userId !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }
  } else {
    const listing = listingId
      ? await prisma.listing.findUnique({ where: { id: listingId }, select: { landlordId: true } })
      : null;
    if (!listing || listing.landlordId !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  // Idempotent: re-submitting the same role's signature doesn't overwrite the
  // original or double-log the activity timeline.
  if (parsed.data.role === "tenant" && draft.tenantSignature) {
    return res.json({
      tenantSigned: true,
      landlordSigned: !!draft.landlordSignature,
      signedAt: (draft.tenantSignedAt ?? new Date()).toISOString(),
    });
  }
  if (parsed.data.role === "landlord" && draft.landlordSignature) {
    return res.json({
      tenantSigned: !!draft.tenantSignature,
      landlordSigned: true,
      signedAt: (draft.landlordSignedAt ?? new Date()).toISOString(),
    });
  }

  const now = new Date();
  const data =
    parsed.data.role === "tenant"
      ? { tenantSignature: parsed.data.signature, tenantSignedAt: now }
      : { landlordSignature: parsed.data.signature, landlordSignedAt: now };

  const updated = await prisma.agreementDraft.update({ where: { id: draft.id }, data });

  // The draft's own profileId is the tenant's in the normal (and shared-listing)
  // flow — it's what disambiguates which tenant's agreement this is. Only log
  // against the tenant-scoped timeline when that holds; skip otherwise rather
  // than mis-attributing an event to the wrong party.
  if (listingId && draft.profile.accountType === "tenant") {
    const wasFullySigned = !!draft.tenantSignature && !!draft.landlordSignature;
    const isNowFullySigned = !!updated.tenantSignature && !!updated.landlordSignature;

    await logActivity({
      listingId,
      tenantProfileId: draft.profileId,
      type:
        parsed.data.role === "tenant"
          ? "agreement_signed_by_tenant"
          : "agreement_signed_by_landlord",
      actor: parsed.data.role,
      summary: `${parsed.data.role === "tenant" ? "Tenant" : "Landlord"} signed the rental agreement (Ref ${draft.reference}).`,
    });

    if (isNowFullySigned && !wasFullySigned) {
      await logActivity({
        listingId,
        tenantProfileId: draft.profileId,
        type: "agreement_fully_executed",
        actor: "system",
        summary: `Rental agreement fully executed — both parties have signed (Ref ${draft.reference}).`,
      });
    }
  }

  return res.json({
    tenantSigned: !!updated.tenantSignature,
    landlordSigned: !!updated.landlordSignature,
    signedAt: now.toISOString(),
  });
}

const deliverSchema = z.object({ reference: z.string() });

export async function deliverAgreement(req, res) {
  const parsed = deliverSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user?.email) return res.status(404).json({ error: "User not found" });

  await agreementDeliveryEmail(user.email, user.name ?? "Tenant", parsed.data.reference);
  return res.json({ ok: true });
}
