import { z } from "zod";
import { prisma } from "../models/prisma.js";
import { geocodeAddress, explainMatch } from "../services/match.js";
import { matchScore } from "../services/match-shared.js";

const roomTypes = ["Single room", "Shared mess", "Studio", "Full flat"];

const preferenceSchema = z.object({
  budgetCeiling: z.coerce.number().int().positive(),
  commuteAnchorLabel: z.string().min(1).max(200),
  roomType: z.enum(roomTypes),
  hasPets: z.boolean(),
  smokes: z.boolean(),
  frequentVisitors: z.boolean(),
  mustHaves: z.array(z.string().min(1).max(60)).max(10).default([]),
});

async function getOwnProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true },
  });
  return user?.profile ?? null;
}

export async function getMatchPreference(req, res) {
  const profile = await getOwnProfile(req.user.id);
  if (!profile) return res.status(401).json({ error: "Unauthorized" });

  const preference = await prisma.listingMatchPreference.findUnique({
    where: { profileId: profile.id },
  });
  return res.json(preference);
}

export async function putMatchPreference(req, res) {
  const profile = await getOwnProfile(req.user.id);
  if (!profile) return res.status(401).json({ error: "Unauthorized" });

  const parsed = preferenceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid preference data." });
  }

  const geocoded = await geocodeAddress(parsed.data.commuteAnchorLabel);
  if (!geocoded) {
    return res.status(422).json({
      error: "Couldn't locate that commute anchor — try a more specific area or landmark name.",
    });
  }

  const data = {
    budgetCeiling: parsed.data.budgetCeiling,
    commuteAnchorLabel: parsed.data.commuteAnchorLabel,
    commuteAnchorLat: geocoded.lat,
    commuteAnchorLng: geocoded.lng,
    roomType: parsed.data.roomType,
    hasPets: parsed.data.hasPets,
    smokes: parsed.data.smokes,
    frequentVisitors: parsed.data.frequentVisitors,
    mustHaves: parsed.data.mustHaves,
  };

  const preference = await prisma.listingMatchPreference.upsert({
    where: { profileId: profile.id },
    update: data,
    create: { profileId: profile.id, ...data },
  });

  return res.json(preference);
}

const explainSchema = z.object({ listingId: z.string().min(1) });

// Deliberately per-listing and only called on demand (a "why this matches →"
// click), never eagerly for a whole search results page — the score itself
// is free (client-computable), but the Gemini explanation is a real network
// call and shouldn't fire N times just for someone to browse a listing grid.
export async function explainListingMatch(req, res) {
  const parsed = explainSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: { include: { matchPreference: true } } },
  });
  if (!user?.profile?.matchPreference) {
    return res.status(409).json({ error: "Save your match preferences first." });
  }

  const listing = await prisma.listing.findUnique({ where: { id: parsed.data.listingId } });
  if (!listing) return res.status(404).json({ error: "Listing not found" });

  const pref = user.profile.matchPreference;
  const result = matchScore(pref, listing);
  const { explanation, source } = await explainMatch(
    pref,
    { ...listing, description: listing.description ?? null },
    result,
  );

  return res.json({
    total: result.total,
    hardBlocked: result.hardBlocked,
    explanation,
    source,
  });
}
