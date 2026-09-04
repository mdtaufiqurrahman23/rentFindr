import { Router } from "express";
import { createMoveOut, getMoveOut, updateMoveOut } from "../controllers/move-out.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const moveOutRoutes = Router();

moveOutRoutes.post("/", requireAuth, asyncHandler(createMoveOut));
moveOutRoutes.get("/:applicationId", requireAuth, asyncHandler(getMoveOut));
moveOutRoutes.patch("/:applicationId", requireAuth, asyncHandler(updateMoveOut));
