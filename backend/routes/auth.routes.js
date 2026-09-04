import { Router } from "express";
import { login, register, me } from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const authRoutes = Router();

authRoutes.post("/login", asyncHandler(login));
authRoutes.post("/register", asyncHandler(register));
authRoutes.get("/me", requireAuth, asyncHandler(me));
