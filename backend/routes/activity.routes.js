import { Router } from "express";
import { listActivityEvents, pingActivity } from "../controllers/activity.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const activityRoutes = Router();

activityRoutes.get("/", requireAuth, asyncHandler(listActivityEvents));
activityRoutes.post("/ping", requireAuth, asyncHandler(pingActivity));
