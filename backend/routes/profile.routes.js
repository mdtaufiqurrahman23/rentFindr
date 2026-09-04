import { Router } from "express";
import { getMyProfile, deleteProfileItem } from "../controllers/profile.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const profileRoutes = Router();

profileRoutes.get("/", requireAuth, asyncHandler(getMyProfile));
profileRoutes.delete("/delete", requireAuth, asyncHandler(deleteProfileItem));
