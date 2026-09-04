import { Router } from "express";
import {
  createAdminInvite,
  listAdminInvites,
  listLandlordVerifications,
  reviewLandlordVerification,
  listTenantVerifications,
  reviewTenantVerification,
} from "../controllers/admin.controller.js";
import { requireAuth, requireRole } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const adminRoutes = Router();

adminRoutes.use(requireAuth, requireRole("ADMIN"));

adminRoutes.post("/invites", asyncHandler(createAdminInvite));
adminRoutes.get("/invites", asyncHandler(listAdminInvites));

adminRoutes.get("/verifications", asyncHandler(listLandlordVerifications));
adminRoutes.patch("/verifications/:verificationId", asyncHandler(reviewLandlordVerification));

adminRoutes.get("/tenant-verifications", asyncHandler(listTenantVerifications));
adminRoutes.patch("/tenant-verifications/:verificationId", asyncHandler(reviewTenantVerification));
