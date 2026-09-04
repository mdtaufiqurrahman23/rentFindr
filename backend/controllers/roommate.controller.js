import { z } from "zod";
import { prisma } from "../models/prisma.js";

const sessionSchema = z.object({
  label: z.string().min(1),
  profileData: z.record(z.unknown()),
  results: z.array(z.record(z.unknown())),
});

export async function createRoommateSession(req, res) {
  const parsed = sessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });

  const session = await prisma.roommateSession.create({
    data: {
      profileId: user.profile.id,
      label: parsed.data.label,
      profileData: parsed.data.profileData,
      results: parsed.data.results,
    },
  });

  return res.json({ id: session.id });
}

export async function listRoommateSessions(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });

  const sessions = await prisma.roommateSession.findMany({
    where: { profileId: user.profile.id },
    orderBy: { createdAt: "desc" },
  });

  return res.json(sessions);
}

const preferenceSchema = z.object({
  budget: z.coerce.number().int().positive(),
  sleep: z.enum(["Early", "Flexible", "Late"]),
  smoking: z.enum(["No", "Tolerant", "Yes"]),
  smokingNonNegotiable: z.boolean(),
  cooking: z.enum(["Rarely", "Occasionally", "Daily"]),
  study: z.enum(["Quiet", "Mixed", "Social"]),
  visitors: z.enum(["Rare", "Occasional", "Frequent"]),
});

async function getOwnProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true },
  });
  return user?.profile ?? null;
}

export async function getRoommatePreference(req, res) {
  const profile = await getOwnProfile(req.user.id);
  if (!profile) return res.status(401).json({ error: "Unauthorized" });

  const preference = await prisma.roommatePreference.findUnique({
    where: { profileId: profile.id },
  });
  return res.json(preference);
}

export async function putRoommatePreference(req, res) {
  const profile = await getOwnProfile(req.user.id);
  if (!profile) return res.status(401).json({ error: "Unauthorized" });

  const parsed = preferenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid preference data." });

  const preference = await prisma.roommatePreference.upsert({
    where: { profileId: profile.id },
    update: parsed.data,
    create: { profileId: profile.id, ...parsed.data },
  });

  return res.json(preference);
}

export async function listRoommateCandidates(req, res) {
  const me = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!me?.profile) return res.status(404).json({ error: "Profile not found" });

  const preferences = await prisma.roommatePreference.findMany({
    where: {
      profileId: { not: me.profile.id },
      profile: { accountType: "tenant", user: { role: "TENANT" } },
    },
    include: {
      profile: {
        include: { user: { select: { email: true } } },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return res.json(
    preferences.map((p) => ({
      profileId: p.profileId,
      displayName: p.profile.displayName,
      email: p.profile.user.email,
      memberSince: p.profile.createdAt,
      budget: p.budget,
      sleep: p.sleep,
      smoking: p.smoking,
      smokingNonNegotiable: p.smokingNonNegotiable,
      cooking: p.cooking,
      study: p.study,
      visitors: p.visitors,
    })),
  );
}
