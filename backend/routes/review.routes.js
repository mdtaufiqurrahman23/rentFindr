import { Router } from "express";
import { getReviews, createReview, getReceivedReviews } from "../controllers/review.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const reviewRoutes = Router();

reviewRoutes.get("/", requireAuth, asyncHandler(getReviews));
reviewRoutes.post("/", requireAuth, asyncHandler(createReview));
reviewRoutes.get("/received", requireAuth, asyncHandler(getReceivedReviews));
