import { prisma } from "../models/prisma.js";
import { getLandlordAnalytics, getTenantAnalytics } from "../services/analytics.js";

export async function landlordAnalytics(req, res) {
  const analytics = await getLandlordAnalytics(req.user.id);
  return res.json(analytics);
}

export async function tenantAnalytics(req, res) {
  const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } });
  if (!profile) return res.status(404).json({ error: "Profile not found" });

  const analytics = await getTenantAnalytics(profile.id);
  return res.json(analytics);
}
