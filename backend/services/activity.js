import { prisma } from "../models/prisma.js";

// ActivityEventType: an open string union in the original TS — gives
// autocomplete for the event types this module writes, while staying
// extensible for other modules (maintenance, repairs, checkout) to log their
// own kinds without a shared enum migration. Not enforced at runtime in JS.
// Known values include: "agreement_signed_by_tenant", "agreement_signed_by_landlord",
// "agreement_fully_executed", "payment_logged", "payment_failed", "dispute_filed",
// "dispute_resolved", "message_flagged", plus others logged elsewhere.

// ActivityActor: "tenant" | "landlord" | "system"

export async function logActivity(params) {
  try {
    await prisma.activityEvent.create({
      data: {
        listingId: params.listingId,
        tenantProfileId: params.tenantProfileId,
        type: params.type,
        actor: params.actor,
        summary: params.summary,
        metadata: params.metadata,
      },
    });
  } catch (error) {
    // Best-effort, like email: a logging failure must never break the action
    // (signing, payment) that triggered it.
    console.error("Failed to log activity event:", params.type, error);
  }
}
