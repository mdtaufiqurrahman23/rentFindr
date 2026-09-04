import { z } from "zod";
import { prisma } from "../models/prisma.js";
import { logActivity } from "../services/activity.js";
import { finalizePayment } from "../services/payment.js";

const schema = z.object({
  listingId: z.string(),
  amount: z.number().positive(),
  month: z.string(),
});

async function markFailed(transactionId, reason) {
  const payment = await prisma.payment.findUnique({ where: { transactionId } });
  if (!payment || payment.status === "paid") return;
  await prisma.payment.update({ where: { transactionId }, data: { status: "failed" } });
  await logActivity({
    listingId: payment.listingId,
    tenantProfileId: payment.profileId,
    type: "payment_failed",
    actor: "system",
    summary: `Rent payment for ${payment.month} was not completed (${reason}).`,
    metadata: { transactionId },
  });
}

export async function initiatePayment(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { profile: true },
  });
  if (!user?.profile) return res.status(404).json({ error: "Profile not found" });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const { listingId, amount, month } = parsed.data;

  // Only the accepted tenant on this listing can log rent for it — otherwise
  // the "tamper-evident" activity trail this feeds could be seeded with
  // payments from accounts that have no real tenancy on the listing.
  const tenancy = await prisma.application.findFirst({
    where: { profileId: user.profile.id, listingId, status: "accepted" },
  });
  if (!tenancy) {
    return res.status(403).json({ error: "You don't have an accepted tenancy on this listing." });
  }

  const storeId = process.env.SSLCOMMERZ_STORE_ID;
  const storePassword = process.env.SSLCOMMERZ_STORE_PASSWORD;
  // SSLCOMMERZ itself hits these URLs (server-to-server + gateway redirects),
  // so they must point at this backend's own public origin, not the frontend.
  const backendBaseUrl = process.env.BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;

  if (!storeId || !storePassword) {
    return res.status(503).json({ error: "SSLCOMMERZ not configured" });
  }

  const transactionId = `BK-${Date.now()}-${listingId}`;

  const params = new URLSearchParams({
    store_id: storeId,
    store_passwd: storePassword,
    total_amount: String(amount),
    currency: "BDT",
    tran_id: transactionId,
    success_url: `${backendBaseUrl}/api/payment/ipn?status=success`,
    fail_url: `${backendBaseUrl}/api/payment/ipn?status=fail`,
    cancel_url: `${backendBaseUrl}/api/payment/ipn?status=cancel`,
    ipn_url: `${backendBaseUrl}/api/payment/ipn`,
    product_name: `Rent for listing ${listingId}`,
    product_category: "Rent",
    product_profile: "general",
    cus_name: String(user.name ?? "Tenant"),
    cus_email: String(user.email ?? ""),
    cus_add1: "Dhaka",
    cus_city: "Dhaka",
    cus_country: "Bangladesh",
    cus_phone: "01700000000",
    shipping_method: "NO",
    num_of_item: "1",
    weight_of_items: "0",
    logistic_pickup_id: "0",
    product_amount: String(amount),
    vat: "0",
    discount_amount: "0",
    convenience_fee: "0",
  });

  const sslRes = await fetch("https://sandbox.sslcommerz.com/gwprocess/v4/api.php", {
    method: "POST",
    body: params,
  });

  const sslData = await sslRes.json();

  if (sslData.status !== "SUCCESS" || !sslData.GatewayPageURL) {
    return res.status(502).json({ error: "Payment gateway error" });
  }

  // Log the pending payment in DB
  await prisma.payment.create({
    data: {
      transactionId,
      listingId,
      profileId: user.profile.id,
      amount,
      month,
      status: "pending",
    },
  });

  return res.json({ url: sslData.GatewayPageURL, transactionId });
}

// SSLCOMMERZ's server-to-server IPN callback — the authoritative path in a real
// deployment. Trusts nothing from the posted form directly: a success status
// still goes through finalizePayment(), which re-validates with SSLCOMMERZ
// before marking anything paid. Unauthenticated by design (SSLCOMMERZ can't
// carry a Bearer token) — the express.urlencoded() middleware applied
// globally in server.js parses the posted form into req.body.
export async function paymentIpnPost(req, res) {
  const body = req.body;
  if (!body) return res.status(400).json({ error: "Bad request" });

  const status = body.status ?? null;
  const transactionId = body.tran_id ?? null;
  const validationId = body.val_id ?? null;

  if (!transactionId) return res.status(400).json({ error: "Missing tran_id" });

  try {
    if (status === "VALID" || status === "VALIDATED") {
      await finalizePayment(transactionId, validationId);
    } else {
      await markFailed(transactionId, status || "cancelled");
    }
  } catch (error) {
    console.error("payment IPN handling failed:", error);
    // Still ack with 200 — SSLCOMMERZ retries on non-2xx, and the browser
    // redirect path (GET, below) provides a second, independent chance to
    // finalize the same transactionId idempotently.
  }

  return res.json({ received: true });
}

// SSLCOMMERZ also redirects the tenant's browser to success/fail/cancel URLs.
// IPN webhooks can't reach a localhost dev server, so this redirect path also
// finalizes the payment when tran_id/val_id are present — same validated,
// idempotent finalizePayment() call, so it's safe even if IPN also fires.
// This is a browser redirect, so it must land back on the frontend's own
// origin (a different origin from the backend now), not the backend's.
export async function paymentIpnGet(req, res) {
  const status = req.query.status ?? null;
  const transactionId = req.query.tran_id ?? null;
  const validationId = req.query.val_id ?? null;
  const frontendBaseUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";

  if (status === "success" && transactionId) {
    await finalizePayment(transactionId, validationId).catch((error) =>
      console.error("finalizePayment (redirect) failed:", error),
    );
    return res.redirect(`${frontendBaseUrl}/profile?payment=success`);
  }
  if (status === "fail") {
    if (transactionId) await markFailed(transactionId, "fail").catch(() => {});
    return res.redirect(`${frontendBaseUrl}/profile?payment=failed`);
  }
  if (transactionId) await markFailed(transactionId, "cancelled").catch(() => {});
  return res.redirect(`${frontendBaseUrl}/profile?payment=cancelled`);
}
