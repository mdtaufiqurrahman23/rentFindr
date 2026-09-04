import { Router } from "express";
import {
  getMatchPreference,
  putMatchPreference,
  explainListingMatch,
} from "../controllers/match.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const matchRoutes = Router();

matchRoutes.get("/preference", requireAuth, asyncHandler(getMatchPreference));
matchRoutes.put("/preference", requireAuth, asyncHandler(putMatchPreference));

matchRoutes.post("/explain", requireAuth, asyncHandler(explainListingMatch));
