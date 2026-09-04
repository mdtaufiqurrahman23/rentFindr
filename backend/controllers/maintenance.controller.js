import { z } from "zod";
import { prisma } from "../models/prisma.js";
import { isOverdue } from "../services/maintenance.js";
import { maintenanceFiledEmail, maintenanceStatusEmail } from "../services/gmail.js";

const createSchema = z.object({
  applicationId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  photoUrl: z.string().optional(),
});

export async function getMaintenanceRequests(req, res) {
  const applicationId = req.query.applicationId;
  if (!applicationId) {
    return res.status(400).json({ error: "applicationId is required" });
  }

  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { listing: true, profile: true },
  });
  if (!application) return res.status(404).json({ error: "Application not found" });

  const userId = req.user.id;
  const isTenant = application.profile.userId === userId;
  const isLandlord = application.listing.landlordId === userId;
  if (!isTenant && !isLandlord) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const requests = await prisma.maintenanceRequest.findMany({
    where: { applicationId },
    orderBy: { createdAt: "desc" },
  });

  return res.json(requests.map((r) => ({ ...r, isOverdue: isOverdue(r.status, r.createdAt) })));
}

export async function createMaintenanceRequest(req, res) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid maintenance request" });
  }

  const application = await prisma.application.findUnique({
    where: { id: parsed.data.applicationId },
    include: { listing: true, profile: true },
  });
  if (!application) return res.status(404).json({ error: "Application not found" });

  if (application.profile.userId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (application.status !== "accepted") {
    return res.status(409).json({
      error: "You can only file maintenance requests for an active tenancy.",
    });
  }

  const created = await prisma.maintenanceRequest.create({
    data: {
      applicationId: application.id,
      title: parsed.data.title,
      description: parsed.data.description,
      photoUrl: parsed.data.photoUrl,
    },
  });

  const landlord = await prisma.user.findUnique({ where: { id: application.listing.landlordId } });
  if (landlord?.email) {
    await maintenanceFiledEmail(
      landlord.email,
      landlord.name ?? "Landlord",
      created.title,
      application.listing.title,
    ).catch(() => {});
  }

  return res.status(201).json({ ...created, isOverdue: false });
}

export async function getLandlordMaintenanceRequests(req, res) {
  const requests = await prisma.maintenanceRequest.findMany({
    where: { application: { listing: { landlordId: req.user.id } } },
    orderBy: { createdAt: "desc" },
    include: {
      application: {
        include: {
          listing: { select: { id: true, title: true } },
          profile: { select: { displayName: true } },
        },
      },
    },
  });

  return res.json(
    requests.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      photoUrl: r.photoUrl,
      status: r.status,
      createdAt: r.createdAt,
      acknowledgedAt: r.acknowledgedAt,
      inProgressAt: r.inProgressAt,
      resolvedAt: r.resolvedAt,
      isOverdue: isOverdue(r.status, r.createdAt),
      listingId: r.application.listing.id,
      listingTitle: r.application.listing.title,
      tenantName: r.application.profile.displayName,
    })),
  );
}

const updateStatusSchema = z.object({
  status: z.enum(["acknowledged", "in_progress", "resolved"]),
});

export async function updateMaintenanceRequestStatus(req, res) {
  const { requestId } = req.params;
  const maintenanceRequest = await prisma.maintenanceRequest.findUnique({
    where: { id: requestId },
    include: { application: { include: { listing: true, profile: true } } },
  });
  if (!maintenanceRequest) {
    return res.status(404).json({ error: "Maintenance request not found" });
  }
  if (maintenanceRequest.application.listing.landlordId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid status" });

  const timestampField =
    parsed.data.status === "acknowledged"
      ? "acknowledgedAt"
      : parsed.data.status === "in_progress"
        ? "inProgressAt"
        : "resolvedAt";

  const updated = await prisma.maintenanceRequest.update({
    where: { id: requestId },
    data: { status: parsed.data.status, [timestampField]: new Date() },
  });

  const tenant = await prisma.user.findUnique({
    where: { id: maintenanceRequest.application.profile.userId },
  });
  if (tenant?.email) {
    await maintenanceStatusEmail(
      tenant.email,
      maintenanceRequest.application.profile.displayName,
      updated.title,
      updated.status,
      maintenanceRequest.application.listing.title,
    ).catch(() => {});
  }

  return res.json({ ...updated, isOverdue: isOverdue(updated.status, updated.createdAt) });
}
