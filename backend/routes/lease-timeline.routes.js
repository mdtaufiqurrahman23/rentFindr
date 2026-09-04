import { Router } from "express";
import { landlordLeaseTimelines } from "../controllers/lease-timeline.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const leaseTimelineRoutes = Router();

leaseTimelineRoutes.get("/landlord", requireAuth, asyncHandler(landlordLeaseTimelines));
