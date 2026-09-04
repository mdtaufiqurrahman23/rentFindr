import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "../models/prisma.js";
import {
  getLandlordSummaries,
  getLandlordSummary,
  getLandlordPublicProfile,
} from "../services/landlord-summary.js";
import { getTrustScoresForLandlords } from "../services/analytics.js";
import { geocodeAddress } from "../services/match.js";
import { matchScore, haversineKm } from "../services/match-shared.js";
import { getPropertyHistory } from "../services/property-history.js";

const roomTypes = ["Single room", "Shared mess", "Studio", "Full flat"];
const MAX_PHOTO_CHARS = 2_200_000; // ~1.6MB raw, base64-inflated — same cap as verification photos
const AUTH_SECRET = process.env.AUTH_SECRET ?? "baskhuji-dev-secret";

// GET /save doesn't 401 on a missing/invalid token — it just reports
// "not saved", same as the original route.ts (only its POST hard-requires
// auth). requireAuth is too strict for it, so decode optimistically here.
function getOptionalUserId(req) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, AUTH_SECRET);
    return String(payload.sub);
  } catch {
    return null;
  }
}

const createListingSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  area: z.string().min(1),
  city: z.string().min(1),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  rent: z.coerce.number().int().positive(),
  deposit: z.coerce.number().int().nonnegative(),
  roomType: z.enum(roomTypes),
  availableFrom: z.string().min(1),
  status: z.enum(["Active", "Draft"]).default("Active"),
  houseRules: z.array(z.string().min(1).max(200)).max(15).optional().default([]),
  photoUrls: z.array(z.string().min(1).max(MAX_PHOTO_CHARS)).max(6).optional().default([]),
  sqft: z.coerce.number().int().positive().max(1_000_000).optional(),
});

const updateListingSchema = createListingSchema;

export async function createListing(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: { include: { landlordVerification: true } } },
  });
  const isLandlord = user?.role === "LANDLORD" || user?.profile?.accountType === "landlord";
  if (!user || !isLandlord) {
    return res.status(403).json({ error: "Only landlord accounts can create listings." });
  }

  const parsed = createListingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? "Invalid listing data." });
  }

  const availableFrom = new Date(parsed.data.availableFrom);
  if (Number.isNaN(availableFrom.getTime())) {
    return res.status(400).json({ error: "Invalid availability date." });
  }

  // Only admin-verified landlords may publish Active (publicly searchable) listings.
  const isVerified = user.profile?.landlordVerification?.status === "verified";
  const status = parsed.data.status === "Active" && !isVerified ? "Draft" : parsed.data.status;

  const listing = await prisma.listing.create({
    data: {
      id: randomUUID(),
      title: parsed.data.title,
      description: parsed.data.description || null,
      area: parsed.data.area,
      city: parsed.data.city,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      rent: parsed.data.rent,
      deposit: parsed.data.deposit,
      roomType: parsed.data.roomType,
      availableFrom,
      status,
      postedOn: new Date(),
      landlordId: user.id,
      houseRules: parsed.data.houseRules,
      photoUrls: parsed.data.photoUrls,
      sqft: parsed.data.sqft ?? null,
    },
  });

  return res.status(201).json({
    ...listing,
    downgradedToDraft: parsed.data.status === "Active" && status === "Draft",
  });
}

export async function listListings(req, res) {
  const area = req.query.area ?? null;
  const roomType = req.query.roomType ?? null;
  const minRent = req.query.minRent ?? null;
  const maxRent = req.query.maxRent ?? null;
  const availableBy = req.query.availableBy ?? null;

  const minRentNum = minRent !== null ? Number(minRent) : undefined;
  const maxRentNum = maxRent !== null ? Number(maxRent) : undefined;
  if (
    (minRentNum !== undefined && !Number.isFinite(minRentNum)) ||
    (maxRentNum !== undefined && !Number.isFinite(maxRentNum))
  ) {
    return res.status(400).json({ error: "Invalid rent filter." });
  }

  let availableByDate;
  if (availableBy) {
    availableByDate = new Date(availableBy);
    if (Number.isNaN(availableByDate.getTime())) {
      return res.status(400).json({ error: "Invalid availability date." });
    }
  }

  const listings = await prisma.listing.findMany({
    where: {
      status: "Active",
      ...(area ? { area } : {}),
      ...(roomType ? { roomType } : {}),
      ...(minRentNum !== undefined || maxRentNum !== undefined
        ? {
            rent: {
              ...(minRentNum !== undefined ? { gte: minRentNum } : {}),
              ...(maxRentNum !== undefined ? { lte: maxRentNum } : {}),
            },
          }
        : {}),
      ...(availableByDate ? { availableFrom: { lte: availableByDate } } : {}),
    },
    orderBy: { postedOn: "desc" },
    include: {
      _count: { select: { applications: true } },
    },
  });

  const landlords = await getLandlordSummaries(listings.map((l) => l.landlordId));
  const withLandlord = listings.map((l) => ({ ...l, landlord: landlords.get(l.landlordId) }));

  return res.json(withLandlord);
}

export async function getListing(req, res) {
  const { listingId } = req.params;

  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: {
      _count: { select: { applications: true } },
    },
  });

  if (!listing) return res.status(404).json({ error: "Listing not found" });

  const landlord = await getLandlordSummary(listing.landlordId);

  return res.json({ ...listing, landlord });
}

// New endpoint (not in the original Next.js app): the public listing-detail
// page used to query Prisma directly from a server component; now that the
// frontend has no DB access, it needs the raw listing plus the public
// landlord profile and property history bundled into one call.
export async function getListingDetail(req, res) {
  const { listingId } = req.params;

  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) return res.status(404).json({ error: "Listing not found" });

  const [owner, history] = await Promise.all([
    getLandlordPublicProfile(listing.landlordId),
    getPropertyHistory(listing.id),
  ]);

  return res.json({ listing, owner, history });
}

export async function updateListing(req, res) {
  const { listingId } = req.params;
  const existing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!existing) return res.status(404).json({ error: "Listing not found" });
  if (existing.landlordId !== req.user.id) {
    return res.status(403).json({ error: "You can only edit your own listings." });
  }

  const parsed = updateListingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? "Invalid listing data." });
  }

  const availableFrom = new Date(parsed.data.availableFrom);
  if (Number.isNaN(availableFrom.getTime())) {
    return res.status(400).json({ error: "Invalid availability date." });
  }

  // Only admin-verified landlords may publish Active (publicly searchable) listings.
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: { include: { landlordVerification: true } } },
  });
  const isVerified = user?.profile?.landlordVerification?.status === "verified";
  const status = parsed.data.status === "Active" && !isVerified ? "Draft" : parsed.data.status;

  const updated = await prisma.listing.update({
    where: { id: listingId },
    data: {
      title: parsed.data.title,
      description: parsed.data.description || null,
      area: parsed.data.area,
      city: parsed.data.city,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      rent: parsed.data.rent,
      deposit: parsed.data.deposit,
      roomType: parsed.data.roomType,
      availableFrom,
      status,
      houseRules: parsed.data.houseRules,
      photoUrls: parsed.data.photoUrls,
      sqft: parsed.data.sqft ?? null,
    },
  });

  return res.json({
    ...updated,
    downgradedToDraft: parsed.data.status === "Active" && status === "Draft",
  });
}

export async function getMyListings(req, res) {
  const listings = await prisma.listing.findMany({
    where: { landlordId: req.user.id },
    orderBy: { postedOn: "desc" },
    include: {
      _count: { select: { applications: true } },
    },
  });

  return res.json(listings);
}

// Read-only — a landmark query param triggers one Nominatim geocode per
// request (not per listing), matching match.server.ts's "once per action,
// never per-listing" usage-policy note.
export async function compareListings(req, res) {
  const userId = req.user.id;
  const profile = await prisma.profile.findUnique({
    where: { userId },
    include: { matchPreference: true },
  });
  if (!profile) return res.status(404).json({ error: "Profile not found" });

  const landmarkQuery =
    typeof req.query.landmark === "string" ? req.query.landmark.trim() : undefined;
  const landmark = landmarkQuery ? await geocodeAddress(landmarkQuery) : null;
  if (landmarkQuery && !landmark) {
    return res
      .status(422)
      .json({ error: "Couldn't locate that landmark — try a more specific area or address." });
  }

  const saved = await prisma.savedListing.findMany({
    where: { profileId: profile.id },
    include: { listing: true },
    orderBy: { createdAt: "desc" },
  });

  const trustScores = await getTrustScoresForLandlords(saved.map((s) => s.listing.landlordId));

  const pref = profile.matchPreference;

  const rows = saved.map((s) => {
    const listing = s.listing;
    return {
      savedId: s.id,
      listingId: listing.id,
      title: listing.title,
      area: listing.area,
      city: listing.city,
      rent: listing.rent,
      roomType: listing.roomType,
      landlordTrustScore: trustScores.get(listing.landlordId) ?? null,
      matchPercent: pref ? matchScore(pref, listing).total : null,
      distanceKm: landmark
        ? Math.round(
            haversineKm(landmark.lat, landmark.lng, listing.latitude, listing.longitude) * 10,
          ) / 10
        : null,
    };
  });

  return res.json({
    landmark: landmark ? { label: landmarkQuery, lat: landmark.lat, lng: landmark.lng } : null,
    rows,
  });
}

const saveSchema = z.object({ listingId: z.string() });

export async function toggleSaveListing(req, res) {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });

  const existing = await prisma.savedListing.findFirst({
    where: { profileId: user.profile.id, listingId: parsed.data.listingId },
  });

  if (existing) {
    // deleteMany instead of delete-by-id: if a concurrent request already
    // removed this row, this just matches zero rows instead of throwing P2025.
    await prisma.savedListing.deleteMany({ where: { id: existing.id } });
    return res.json({ saved: false });
  }

  try {
    await prisma.savedListing.create({
      data: { profileId: user.profile.id, listingId: parsed.data.listingId },
    });
  } catch (err) {
    // A concurrent request already created the same (profileId, listingId)
    // row between our findFirst and this create — that's fine, end state is
    // the same either way.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
      throw err;
    }
  }
  return res.json({ saved: true });
}

export async function getSaveStatus(req, res) {
  const userId = getOptionalUserId(req);
  if (!userId) return res.json({ saved: false });

  const listingId = req.query.listingId;
  if (!listingId) return res.json({ saved: false });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true },
  });
  if (!user?.profile) return res.json({ saved: false });

  const existing = await prisma.savedListing.findFirst({
    where: { profileId: user.profile.id, listingId },
  });
  return res.json({ saved: !!existing });
}
