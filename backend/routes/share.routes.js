import { Router } from "express";
import { createShare, revokeShare, resolveShare } from "../controllers/share.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const shareRoutes = Router();

shareRoutes.post("/", requireAuth, asyncHandler(createShare));
shareRoutes.delete("/", requireAuth, asyncHandler(revokeShare));
shareRoutes.get("/", asyncHandler(resolveShare));
