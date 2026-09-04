import "dotenv/config";
import express from "express";
import cors from "cors";

import { corsOptions } from "./config/cors.js";
import { errorHandler } from "./middleware/error.middleware.js";

import { authRoutes } from "./routes/auth.routes.js";
import { profileRoutes } from "./routes/profile.routes.js";
import { activityRoutes } from "./routes/activity.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { agreementRoutes } from "./routes/agreement.routes.js";
import { analyticsRoutes } from "./routes/analytics.routes.js";
import { applicationRoutes } from "./routes/application.routes.js";
import { cronRoutes } from "./routes/cron.routes.js";
import { disputeRoutes } from "./routes/dispute.routes.js";
import { improvementCostRoutes } from "./routes/improvement-cost.routes.js";
import { landlordRoutes } from "./routes/landlord.routes.js";
import { leaseTimelineRoutes } from "./routes/lease-timeline.routes.js";
import { listingRoutes } from "./routes/listing.routes.js";
import { maintenanceRoutes } from "./routes/maintenance.routes.js";
import { matchRoutes } from "./routes/match.routes.js";
import { messageRoutes } from "./routes/message.routes.js";
import { moveOutRoutes } from "./routes/move-out.routes.js";
import { paymentRoutes } from "./routes/payment.routes.js";
import { reviewRoutes } from "./routes/review.routes.js";
import { roommateRoutes } from "./routes/roommate.routes.js";
import { shareRoutes } from "./routes/share.routes.js";
import { tenantRoutes } from "./routes/tenant.routes.js";

export const app = express();

app.use(cors(corsOptions));
// Raised from Express's 100kb default — several endpoints (register, tenant
// verification, listing photos, landlord documents) carry base64-encoded
// images as plain JSON string fields rather than multipart uploads.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/agreement", agreementRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/applications", applicationRoutes);
app.use("/api/cron", cronRoutes);
app.use("/api/disputes", disputeRoutes);
app.use("/api/improvement-costs", improvementCostRoutes);
app.use("/api/landlord", landlordRoutes);
app.use("/api/lease-timeline", leaseTimelineRoutes);
app.use("/api/listings", listingRoutes);
app.use("/api/maintenance", maintenanceRoutes);
app.use("/api/match", matchRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/move-out", moveOutRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/roommates", roommateRoutes);
app.use("/api/share", shareRoutes);
app.use("/api/tenant", tenantRoutes);

app.use(errorHandler);
