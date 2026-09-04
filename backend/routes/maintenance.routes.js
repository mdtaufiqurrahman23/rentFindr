import { Router } from "express";
import {
  getMaintenanceRequests,
  createMaintenanceRequest,
  getLandlordMaintenanceRequests,
  updateMaintenanceRequestStatus,
} from "../controllers/maintenance.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const maintenanceRoutes = Router();

maintenanceRoutes.get("/", requireAuth, asyncHandler(getMaintenanceRequests));
maintenanceRoutes.post("/", requireAuth, asyncHandler(createMaintenanceRequest));
maintenanceRoutes.get("/landlord", requireAuth, asyncHandler(getLandlordMaintenanceRequests));
maintenanceRoutes.patch("/:requestId", requireAuth, asyncHandler(updateMaintenanceRequestStatus));
