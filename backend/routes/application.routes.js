import { Router } from "express";
import {
  listApplicationsForListing,
  createApplication,
  getMyApplications,
  getLandlordApplications,
  getApplication,
  updateApplicationStatus,
} from "../controllers/application.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const applicationRoutes = Router();

// Specific/static paths before the ":applicationId" param route.
applicationRoutes.get("/mine", requireAuth, asyncHandler(getMyApplications));
applicationRoutes.get("/landlord", requireAuth, asyncHandler(getLandlordApplications));

applicationRoutes.get("/", requireAuth, asyncHandler(listApplicationsForListing));
applicationRoutes.post("/", requireAuth, asyncHandler(createApplication));

applicationRoutes.get("/:applicationId", requireAuth, asyncHandler(getApplication));
applicationRoutes.patch("/:applicationId", requireAuth, asyncHandler(updateApplicationStatus));
