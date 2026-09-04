import { Router } from "express";
import {
  getTenantVerification,
  submitTenantVerification,
} from "../controllers/tenant.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const tenantRoutes = Router();

tenantRoutes.get("/verification", requireAuth, asyncHandler(getTenantVerification));
tenantRoutes.post("/verification", requireAuth, asyncHandler(submitTenantVerification));
