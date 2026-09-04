import { z } from "zod";
import { prisma } from "../models/prisma.js";
import { sendEmail } from "../services/gmail.js";

const createSchema = z.object({
  type: z.enum(["agreement", "roommate_session"]),
  resourceId: z.string(),
  recipientEmail: z.string().email().optional(),
  recipientName: z.string().optional(),
});

const revokeSchema = z.object({ token: z.string() });

export async function createShare(req, res) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });

  // Only the owner of the underlying resource may mint a share link for it —
  // otherwise any signed-in user could share (and email out) someone else's
  // private agreement or roommate session just by guessing/knowing its id.
  const owns =
    parsed.data.type === "agreement"
      ? await prisma.agreementDraft.findFirst({
          where: { id: parsed.data.resourceId, profileId: user.profile.id },
          select: { id: true },
        })
      : await prisma.roommateSession.findFirst({
          where: { id: parsed.data.resourceId, profileId: user.profile.id },
          select: { id: true },
        });
  if (!owns) return res.status(404).json({ error: "Resource not found" });

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const link = await prisma.shareLink.create({
    data: {
      type: parsed.data.type,
      resourceId: parsed.data.resourceId,
      profileId: user.profile.id,
      expiresAt,
    },
  });

  const shareUrl = `${process.env.FRONTEND_URL}/share/${link.token}`;

  if (parsed.data.recipientEmail) {
    const label =
      parsed.data.type === "agreement" ? "rental agreement" : "roommate matching session";
    await sendEmail({
      to: parsed.data.recipientEmail,
      subject: `${user.profile.displayName} shared a ${label} with you — rentFindr`,
      html: `<p>Hi${parsed.data.recipientName ? ` ${parsed.data.recipientName}` : ""},</p>
<p><strong>${user.profile.displayName}</strong> has shared a ${label} with you on rentFindr.</p>
<p><a href="${shareUrl}">View it here</a> — this link expires in 7 days.</p>
<p>— rentFindr</p>`,
    });
  }

  return res.json({ token: link.token, url: shareUrl, expiresAt });
}

export async function revokeShare(req, res) {
  const parsed = revokeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });

  const link = await prisma.shareLink.findFirst({
    where: { token: parsed.data.token, profileId: user.profile.id },
  });
  if (!link) return res.status(404).json({ error: "Not found" });

  await prisma.shareLink.update({ where: { id: link.id }, data: { revoked: true } });
  return res.json({ ok: true });
}

export async function resolveShare(req, res) {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: "Missing token" });

  const link = await prisma.shareLink.findUnique({ where: { token } });
  if (!link || link.revoked || link.expiresAt < new Date()) {
    return res.status(410).json({ error: "Link is invalid or has expired" });
  }

  if (link.type === "agreement") {
    const draft = await prisma.agreementDraft.findUnique({ where: { id: link.resourceId } });
    if (!draft) return res.status(404).json({ error: "Resource not found" });
    return res.json({ type: "agreement", data: draft, expiresAt: link.expiresAt });
  } else {
    const session = await prisma.roommateSession.findUnique({ where: { id: link.resourceId } });
    if (!session) return res.status(404).json({ error: "Resource not found" });
    return res.json({ type: "roommate_session", data: session, expiresAt: link.expiresAt });
  }
}
