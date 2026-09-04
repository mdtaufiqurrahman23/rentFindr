import { Router } from "express";
import {
  draftAgreement,
  saveAgreement,
  signAgreement,
  deliverAgreement,
} from "../controllers/agreement.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const agreementRoutes = Router();

agreementRoutes.post("/draft", requireAuth, asyncHandler(draftAgreement));
agreementRoutes.post("/save", requireAuth, asyncHandler(saveAgreement));
agreementRoutes.post("/sign", requireAuth, asyncHandler(signAgreement));
agreementRoutes.post("/deliver", requireAuth, asyncHandler(deliverAgreement));
