import { Router } from "express";
import { triggerScheduledReminders } from "../controllers/cron.controller.js";
import { requireCronSecret } from "../middleware/cron.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const cronRoutes = Router();

// Not user-authenticated — meant to be hit by an external scheduler (cron,
// Windows Task Scheduler, a GitHub Action, etc.), not a logged-in browser
// session. Guarded by a shared secret instead of a user session.
cronRoutes.post("/reminders", requireCronSecret, asyncHandler(triggerScheduledReminders));
