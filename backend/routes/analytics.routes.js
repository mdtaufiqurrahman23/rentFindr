import { Router } from "express";
import { landlordAnalytics, tenantAnalytics } from "../controllers/analytics.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const analyticsRoutes = Router();

analyticsRoutes.get("/landlord", requireAuth, asyncHandler(landlordAnalytics));
analyticsRoutes.get("/tenant", requireAuth, asyncHandler(tenantAnalytics));
