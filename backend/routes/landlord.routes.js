import { Router } from "express";
import {
  listLandlordDocuments,
  createLandlordDocument,
  deleteLandlordDocument,
  getLandlordTrustSignalsHandler,
  getLandlordVerification,
} from "../controllers/landlord.controller.js";
import { requireAuth, requireRole } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const landlordRoutes = Router();

landlordRoutes.get("/documents", requireAuth, asyncHandler(listLandlordDocuments));
landlordRoutes.post(
  "/documents",
  requireAuth,
  requireRole("LANDLORD"),
  asyncHandler(createLandlordDocument),
);
landlordRoutes.delete("/documents/:documentId", requireAuth, asyncHandler(deleteLandlordDocument));

landlordRoutes.get("/trust-signals", requireAuth, asyncHandler(getLandlordTrustSignalsHandler));
landlordRoutes.get("/verification", requireAuth, asyncHandler(getLandlordVerification));
