import { Router } from "express";
import {
  listAllDisputes,
  createDispute,
  getMyDisputes,
  getDispute,
  resolveDispute,
} from "../controllers/dispute.controller.js";
import { requireAuth, requireRole } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const disputeRoutes = Router();

disputeRoutes.get("/mine", requireAuth, asyncHandler(getMyDisputes));

// Admin-only: every open/resolved dispute across the platform.
disputeRoutes.get("/", requireAuth, requireRole("ADMIN"), asyncHandler(listAllDisputes));
disputeRoutes.post("/", requireAuth, asyncHandler(createDispute));

disputeRoutes.get("/:disputeId", requireAuth, asyncHandler(getDispute));
// Admin-only: issues the final, binding written resolution.
disputeRoutes.patch("/:disputeId", requireAuth, requireRole("ADMIN"), asyncHandler(resolveDispute));
