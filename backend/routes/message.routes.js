import { Router } from "express";
import { listMessages, createMessage, listThreads } from "../controllers/message.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const messageRoutes = Router();

messageRoutes.get("/threads", requireAuth, asyncHandler(listThreads));

messageRoutes.get("/", requireAuth, asyncHandler(listMessages));
messageRoutes.post("/", requireAuth, asyncHandler(createMessage));
