import { prisma } from "../models/prisma.js";
import { paymentReceiptEmail, paymentConfirmationEmailForLandlord } from "./gmail.js";
import { logActivity } from "./activity.js";

// SslcommerzValidation = { status?: string, tran_id?: string, amount?: string }

async function validateWithSslcommerz(valId) {
  const storeId = process.env.SSLCOMMERZ_STORE_ID;
  const storePassword = process.env.SSLCOMMERZ_STORE_PASSWORD;
  if (!storeId || !storePassword) return null;

  const url = new URL("https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php");
  url.searchParams.set("val_id", valId);
  url.searchParams.set("store_id", storeId);
  url.searchParams.set("store_passwd", storePassword);
  url.searchParams.set("format", "json");

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    console.error("SSLCOMMERZ validation request failed:", error);
    return null;
  }
}

/**
 * Confirms a transaction directly with SSLCOMMERZ before trusting it, then
 * updates the payment, notifies both parties, and logs the activity event.
 * Idempotent — safe to call from both the IPN webhook and the browser
 * redirect, since a real deployment may receive either or both.
 */
export async function finalizePayment(transactionId, valId) {
  const payment = await prisma.payment.findUnique({
    where: { transactionId },
    include: { listing: true },
  });
  if (!payment) return { ok: false, reason: "not_found" };
  if (payment.status === "paid") return { ok: true, alreadyProcessed: true };

  const validation = valId ? await validateWithSslcommerz(valId) : null;
  const isValid =
    !!validation &&
    (validation.status === "VALID" || validation.status === "VALIDATED") &&
    validation.tran_id === payment.transactionId &&
    Math.round(Number(validation.amount)) === payment.amount;

  if (!isValid) {
    await prisma.payment.update({ where: { transactionId }, data: { status: "failed" } });
    await logActivity({
      listingId: payment.listingId,
      tenantProfileId: payment.profileId,
      type: "payment_failed",
      actor: "system",
      summary: `Rent payment attempt for ${payment.month} could not be verified with the payment gateway.`,
      metadata: { transactionId, amount: payment.amount, month: payment.month },
    });
    return { ok: false, reason: "invalid" };
  }

  await prisma.payment.update({
    where: { transactionId },
    data: { status: "paid", validationId: valId },
  });

  // Logged before the (best-effort) emails below: this is the tamper-evident
  // audit trail the platform is actually built around, and finalizePayment()
  // short-circuits to "alreadyProcessed" on any retry once status is "paid" —
  // so if this ran after the emails and an email step failed, the log entry
  // would be permanently skipped with no way to retry it.
  await logActivity({
    listingId: payment.listingId,
    tenantProfileId: payment.profileId,
    type: "payment_logged",
    actor: "tenant",
    summary: `Rent payment of ৳${payment.amount.toLocaleString("en-BD")} logged for ${payment.month}.`,
    metadata: { transactionId, amount: payment.amount, month: payment.month },
  });

  const [tenantProfile, landlordUser] = await Promise.all([
    prisma.profile.findUnique({ where: { id: payment.profileId }, include: { user: true } }),
    prisma.user.findUnique({
      where: { id: payment.listing.landlordId },
      include: { profile: true },
    }),
  ]);

  if (tenantProfile?.user.email) {
    await paymentReceiptEmail(
      tenantProfile.user.email,
      tenantProfile.displayName,
      payment.amount,
      payment.month,
    );
  }
  if (landlordUser?.email) {
    await paymentConfirmationEmailForLandlord(
      landlordUser.email,
      landlordUser.profile?.displayName ?? landlordUser.name ?? "Landlord",
      tenantProfile?.displayName ?? "Tenant",
      payment.amount,
      payment.month,
    );
  }

  return { ok: true, alreadyProcessed: false };
}
