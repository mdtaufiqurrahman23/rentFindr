import { Router } from "express";
import {
  getImprovementCosts,
  createImprovementCost,
  decideImprovementCost,
} from "../controllers/improvement-cost.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const improvementCostRoutes = Router();

improvementCostRoutes.get("/", requireAuth, asyncHandler(getImprovementCosts));
improvementCostRoutes.post("/", requireAuth, asyncHandler(createImprovementCost));
improvementCostRoutes.patch("/:costId", requireAuth, asyncHandler(decideImprovementCost));
