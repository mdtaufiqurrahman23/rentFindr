import { z } from "zod";

import { prisma } from "../models/prisma.js";
import { flagMessage } from "../services/messaging.js";
import { logActivity } from "../services/activity.js";
import { newMessageEmail } from "../services/gmail.js";

const createSchema = z.object({
  applicationId: z.string().min(1),
  body: z.string().min(1).max(4000),
});

async function loadPartyScoped(applicationId, userId) {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { listing: true, profile: true },
  });
  if (!application) return { application: null };
  const isTenant = application.profile.userId === userId;
  const isLandlord = application.listing.landlordId === userId;
  return { application, isTenant, isLandlord, allowed: isTenant || isLandlord };
}

export async function listMessages(req, res) {
  const applicationId = req.query.applicationId;
  if (!applicationId) {
    return res.status(400).json({ error: "applicationId is required" });
  }

  const { application, allowed } = await loadPartyScoped(applicationId, req.user.id);
  if (!application) return res.status(404).json({ error: "Application not found" });
  if (!allowed) return res.status(403).json({ error: "Forbidden" });

  const messages = await prisma.message.findMany({
    where: { applicationId },
    orderBy: { createdAt: "asc" },
    include: { sender: { select: { displayName: true } } },
  });

  return res.json(
    messages.map((m) => ({
      id: m.id,
      senderRole: m.senderRole,
      senderName: m.sender.displayName,
      body: m.body,
      flagged: m.flagged,
      flagReason: m.flagReason,
      createdAt: m.createdAt,
    })),
  );
}

// Everything the deferred block below does is non-essential to message
// delivery — the Gemini flag scan alone is a full network round-trip (often
// 1-3+ seconds) and used to sit directly in the response path, making every
// send feel sluggish. Next.js used `after()` to run this past the response;
// Express has no equivalent, so it's simply fired without awaiting, right
// before `res.json(...)` — the long-lived Node process keeps running it, no
// serverless cutoff risk like on Next. A flagged message (and its
// email/activity-log side effects) shows up on the thread's next fetch
// instead of in this response.
async function moderateAndNotify(message, application, isTenant, body) {
  const flag = await flagMessage(body);
  if (flag.flagged) {
    await prisma.message.update({
      where: { id: message.id },
      data: { flagged: true, flagReason: flag.reason },
    });
    await logActivity({
      listingId: application.listingId,
      tenantProfileId: application.profileId,
      type: "message_flagged",
      actor: isTenant ? "tenant" : "landlord",
      summary: `A message was flagged for potential evidence value: ${flag.reason ?? "key term detected"}.`,
      metadata: { messageId: message.id },
    });
  }

  const [landlordUser, tenantUser] = await Promise.all([
    prisma.user.findUnique({ where: { id: application.listing.landlordId } }),
    prisma.user.findUnique({ where: { id: application.profile.userId } }),
  ]);
  const counterpartyEmail = isTenant ? landlordUser?.email : tenantUser?.email;
  const counterpartyName = isTenant
    ? (landlordUser?.name ?? "Landlord")
    : application.profile.displayName;
  if (counterpartyEmail) {
    await newMessageEmail(
      counterpartyEmail,
      counterpartyName,
      message.sender.displayName,
      application.listing.title,
    ).catch(() => {});
  }
}

export async function createMessage(req, res) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid message" });

  const userId = req.user.id;
  const { application, isTenant, isLandlord, allowed } = await loadPartyScoped(
    parsed.data.applicationId,
    userId,
  );
  if (!application) return res.status(404).json({ error: "Application not found" });
  if (!allowed) return res.status(403).json({ error: "Forbidden" });
  if (application.status === "declined") {
    return res.status(409).json({ error: "This application was declined — messaging is closed." });
  }

  const senderProfileId = isTenant
    ? application.profileId
    : (await prisma.profile.findUnique({ where: { userId } }))?.id;
  if (!senderProfileId) return res.status(404).json({ error: "Profile not found" });

  const message = await prisma.message.create({
    data: {
      applicationId: application.id,
      senderProfileId,
      senderRole: isTenant ? "tenant" : "landlord",
      body: parsed.data.body,
    },
    include: { sender: { select: { displayName: true } } },
  });

  // Fire-and-forget — do NOT await; see moderateAndNotify's comment above.
  moderateAndNotify(message, application, isTenant, parsed.data.body).catch(console.error);

  return res.status(201).json({
    id: message.id,
    senderRole: message.senderRole,
    senderName: message.sender.displayName,
    body: message.body,
    flagged: message.flagged,
    flagReason: message.flagReason,
    createdAt: message.createdAt,
  });
}

// Every non-declined application the caller is a party to (tenant or
// landlord side), each with its most recent message if any — a thread list,
// not an open-ended inbox, matching the "tied to a specific listing or
// active agreement" premise from the proposal.
export async function listThreads(req, res) {
  const userId = req.user.id;
  const profile = await prisma.profile.findUnique({ where: { userId } });

  const applications = await prisma.application.findMany({
    where: {
      status: { not: "declined" },
      OR: [...(profile ? [{ profileId: profile.id }] : []), { listing: { landlordId: userId } }],
    },
    orderBy: { createdAt: "desc" },
    include: {
      listing: { select: { id: true, title: true, area: true, landlordId: true } },
      profile: { select: { displayName: true } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { body: true, senderRole: true, createdAt: true },
      },
      _count: { select: { messages: true } },
    },
  });

  const landlordIds = [...new Set(applications.map((a) => a.listing.landlordId))];
  const landlordUsers = await prisma.user.findMany({
    where: { id: { in: landlordIds } },
    select: { id: true, name: true },
  });
  const landlordNameById = new Map(landlordUsers.map((u) => [u.id, u.name ?? "Landlord"]));

  return res.json(
    applications.map((a) => {
      const isTenant = profile ? a.profileId === profile.id : false;
      return {
        applicationId: a.id,
        status: a.status,
        listingId: a.listing.id,
        listingTitle: a.listing.title,
        listingArea: a.listing.area,
        counterpartyName: isTenant
          ? (landlordNameById.get(a.listing.landlordId) ?? "Landlord")
          : a.profile.displayName,
        messageCount: a._count.messages,
        lastMessage: a.messages[0] ?? null,
      };
    }),
  );
}
