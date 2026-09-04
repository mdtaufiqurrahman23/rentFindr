import { Router } from "express";
import {
  createRoommateSession,
  listRoommateSessions,
  getRoommatePreference,
  putRoommatePreference,
  listRoommateCandidates,
} from "../controllers/roommate.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const roommateRoutes = Router();

roommateRoutes.post("/session", requireAuth, asyncHandler(createRoommateSession));
roommateRoutes.get("/session", requireAuth, asyncHandler(listRoommateSessions));

roommateRoutes.get("/preference", requireAuth, asyncHandler(getRoommatePreference));
roommateRoutes.put("/preference", requireAuth, asyncHandler(putRoommatePreference));

roommateRoutes.get("/candidates", requireAuth, asyncHandler(listRoommateCandidates));
