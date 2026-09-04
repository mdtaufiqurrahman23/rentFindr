import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../models/prisma.js";
import {
  LANDLORD_REVIEW_CATEGORIES,
  TENANT_REVIEW_CATEGORIES,
  overallFromCategories,
} from "../services/reviews.js";

const landlordCategorySchema = z.object(
  Object.fromEntries(
    LANDLORD_REVIEW_CATEGORIES.map((c) => [c.key, z.number().int().min(1).max(5)]),
  ),
);
const tenantCategorySchema = z.object(
  Object.fromEntries(TENANT_REVIEW_CATEGORIES.map((c) => [c.key, z.number().int().min(1).max(5)])),
);

const createSchema = z.object({
  applicationId: z.string().min(1),
  categoryRatings: z.record(z.string(), z.number()),
  comment: z.string().optional(),
});

export async function getReviews(req, res) {
  const applicationId = req.query.applicationId;
  if (!applicationId) {
    return res.status(400).json({ error: "applicationId is required" });
  }

  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { listing: true, profile: true },
  });
  if (!application) return res.status(404).json({ error: "Application not found" });

  const userId = req.user.id;
  const isTenant = application.profile.userId === userId;
  const isLandlord = application.listing.landlordId === userId;
  if (!isTenant && !isLandlord) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const reviews = await prisma.review.findMany({
    where: { applicationId },
    include: { raterProfile: { select: { displayName: true } } },
  });

  return res.json(
    reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      categoryRatings: r.categoryRatings,
      createdAt: r.createdAt,
      raterIsTenant: r.raterProfileId === application.profileId,
      raterName: r.raterProfile.displayName,
    })),
  );
}

export async function createReview(req, res) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid review" });

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
  if (application.status !== "completed") {
    return res.status(409).json({ error: "Reviews unlock once this tenancy has ended." });
  }

  const raterProfileId = isTenant
    ? application.profileId
    : (await prisma.profile.findUnique({ where: { userId } }))?.id;
  if (!raterProfileId) return res.status(404).json({ error: "Profile not found" });

  // A tenant rates the landlord, so their categories are the landlord set,
  // and vice versa — reject the wrong category set outright rather than
  // silently accepting mismatched keys.
  const categorySchema = isTenant ? landlordCategorySchema : tenantCategorySchema;
  const categoryParsed = categorySchema.safeParse(parsed.data.categoryRatings);
  if (!categoryParsed.success) {
    return res.status(400).json({ error: "Invalid category ratings for this role." });
  }

  try {
    const review = await prisma.review.create({
      data: {
        applicationId: application.id,
        raterProfileId,
        rating: overallFromCategories(categoryParsed.data),
        comment: parsed.data.comment,
        categoryRatings: categoryParsed.data,
      },
    });
    return res.status(201).json(review);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "You've already reviewed this tenancy." });
    }
    throw err;
  }
}

export async function getReceivedReviews(req, res) {
  const userId = req.user.id;
  const profile = await prisma.profile.findUnique({ where: { userId } });
  if (!profile) return res.status(404).json({ error: "Profile not found" });

  // Reviews received as a tenant
  const asTenant = await prisma.review.findMany({
    where: { application: { profileId: profile.id }, raterProfileId: { not: profile.id } },
    include: { application: { include: { listing: { select: { title: true } } } } },
  });

  // Reviews received as a landlord
  const asLandlord = await prisma.review.findMany({
    where: {
      application: { listing: { landlordId: userId } },
      raterProfileId: { not: profile.id },
    },
    include: { application: { include: { listing: { select: { title: true } } } } },
  });

  const reviews = [...asTenant, ...asLandlord].map((r) => ({
    id: r.id,
    rating: r.rating,
    comment: r.comment,
    categoryRatings: r.categoryRatings,
    createdAt: r.createdAt,
    listingTitle: r.application.listing.title,
  }));

  const average =
    reviews.length > 0 ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : null;

  return res.json({ reviews, average, count: reviews.length });
}
