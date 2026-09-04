import { Router } from "express";
import {
  initiatePayment,
  paymentIpnPost,
  paymentIpnGet,
} from "../controllers/payment.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const paymentRoutes = Router();

paymentRoutes.post("/initiate", requireAuth, asyncHandler(initiatePayment));
// Unauthenticated: hit by SSLCOMMERZ server-to-server (POST) and the tenant's
// browser redirect (GET) — neither carries a Bearer token.
paymentRoutes.post("/ipn", asyncHandler(paymentIpnPost));
paymentRoutes.get("/ipn", asyncHandler(paymentIpnGet));
