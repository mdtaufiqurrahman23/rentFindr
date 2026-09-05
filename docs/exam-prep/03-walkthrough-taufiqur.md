# Taufiqur's rentFindr Features — Live Modification Exam Study Guide

Backend is a standalone Express + Prisma app under `backend/`, mounted in `backend/app.js` with prefixes like:

```js
app.use("/api/agreement", agreementRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/move-out", moveOutRoutes);
app.use("/api/cron", cronRoutes);
app.use("/api/lease-timeline", leaseTimelineRoutes);
app.use("/api/improvement-costs", improvementCostRoutes);
```

Frontend is Next.js (`src/app`, `src/components`) and every backend call goes through the shared `apiFetch()` helper (`src/lib/api-client.ts`) which just wraps `fetch` and attaches the auth session.

---

## AI-Powered Digital Rental Agreement Generator

**Files:**
- `backend/controllers/agreement.controller.js`
- `backend/services/agreement.js`
- `backend/services/gmail.js`
- `backend/routes/agreement.routes.js`
- `src/app/agreement/page.tsx`
- `src/components/signature-pad.tsx`
- `src/lib/agreement-pdf.ts`
- `src/components/share-panel.tsx`

**How it works:**

The whole feature is one long-lived draft record (`AgreementDraft` in Prisma) keyed by a `reference` string built on the frontend as `${listingId}/${duration}M` (e.g. `abc123/12M`). Everything — drafting, saving, signing, emailing — revolves around that reference plus the draft's DB id.

**1. Drafting clauses (`draftAgreementClauses` in `services/agreement.js`).** This is the "decide AI vs fallback" logic the whole feature hinges on:

```js
export async function draftAgreementClauses(terms) {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) {
    return { clauses: fallbackClauses(terms), source: "fallback", error: "Gemini is not configured." };
  }
  ...
  try {
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" });
    const response = await model.generateContent(`${prompt}\n\nReturn strict JSON in the form {"clauses":[...]}`);
    ...
    if (clauses.length === 0) {
      return { clauses: fallbackClauses(terms), source: "fallback", error: "AI returned empty clauses." };
    }
    return { clauses, source: "ai" };
  } catch (error) {
    ... // 429/403 handled specially
    return { clauses: fallbackClauses(terms), source: "fallback", error: ... };
  }
}
```

So there are exactly three ways you land on the **fallback** path instead of **ai**: no API key configured at all, Gemini's JSON came back empty/unparseable after validation, or the API call throws (network, rate limit, permission denied). Every response carries a `source` field (`"ai"` | `"fallback"`) so the UI can show which one happened.

The prompt itself (lines ~69–85) is built as a joined array of instruction lines plus interpolated facts (`terms.landlordName`, `terms.rent`, etc.) — explicitly told "never invent names, amounts or dates," 6–9 clauses, no markdown. The raw Gemini text is then stripped of ```json fences and `JSON.parse`d.

Validation is defense-in-depth against a malformed AI response:
```js
const shapeParsed = clauseListShapeSchema.safeParse(JSON.parse(text));
const clauses = (shapeParsed.success ? shapeParsed.data.clauses : [])
  .map((c) => clauseItemSchema.safeParse(c))
  .filter((r) => r.success)
  .map((r) => r.data)
  .filter((c) => c.title && c.body)
  .slice(0, 12);
```
Each clause is validated *independently* — one garbage clause from the model doesn't throw away all the good ones (this is a deliberate design comment in the code).

**2. The deterministic fallback (`fallbackClauses(t)`).** Plain JS building a fixed array of `{title, body}` objects: Parties, Premises, Term, Rent and deposit, optionally House rules (only if `t.houseRules.length > 0`), and a closing "Record of tenancy" clause. All values are template-string-interpolated directly from `terms` — no AI involved, so it's instant and 100% deterministic. This is what a student would recreate if asked to explain "what happens if Gemini is down."

**3. Controller layer (`agreement.controller.js`).**
- `draftAgreement`: validates `req.body` against `agreementTermsSchema` (zod), calls `draftAgreementClauses`, returns `{clauses, source, error?}` directly — it does **not** persist anything.
- `saveAgreement`: separately persists the draft via an **upsert** on the compound unique key `(profileId, reference)`:
```js
const draft = await prisma.agreementDraft.upsert({
  where: { profileId_reference: { profileId: user.profile.id, reference: parsed.data.reference } },
  update: { clausesJson: ..., source: ..., termsJson: ... },
  create: { profileId: ..., reference: ..., termsJson: ..., clausesJson: ..., source: ... },
});
```
  The comment explains why upsert and not findFirst-then-create: a `findFirst` + conditional create/update could race two concurrent requests into creating two rows; upsert on the unique constraint is atomic.
- `signAgreement`: this is the meatiest one. It validates a data-URL PNG (`DATA_URL_RE`, capped at `MAX_SIGNATURE_LENGTH`), loads the draft, and authorizes by role:
```js
if (parsed.data.role === "tenant") {
  if (draft.profile.userId !== userId) return res.status(403).json({ error: "Forbidden" });
} else {
  const listing = listingId ? await prisma.listing.findUnique({ where: { id: listingId }, select: { landlordId: true } }) : null;
  if (!listing || listing.landlordId !== userId) return res.status(403).json({ error: "Forbidden" });
}
```
  (Note: `listingId` here is derived by splitting `draft.reference` on `/` — the reference format `listingId/durationM` is load-bearing for this authorization check.)

  It's **idempotent**: if the role already has a signature stored, it just echoes back the current state instead of overwriting or re-logging:
```js
if (parsed.data.role === "tenant" && draft.tenantSignature) {
  return res.json({ tenantSigned: true, landlordSigned: !!draft.landlordSignature, signedAt: ... });
}
```
  After actually writing the signature, it logs an activity event (`agreement_signed_by_tenant`/`_by_landlord`), and if this signature is the one that completes *both* signatures, it fires a second event `agreement_fully_executed` — computed by comparing "was fully signed before this update" vs "is fully signed now" so that event fires exactly once.

- `deliverAgreement`: looks up the signed-in user's email and calls `agreementDeliveryEmail(user.email, user.name, reference)` (in `services/gmail.js`) — just sends a "your agreement is ready" HTML email, escaping all interpolated values with a local `escapeHtml()` helper first (defense against stored XSS via display names).

**4. The signature pad (`src/components/signature-pad.tsx`).** Two modes: "draw" (an HTML `<canvas>` with pointer events building a path) and "type" (renders a cursive-font string onto an offscreen canvas via `renderTypedSignature()`). Both funnel into `onSave(dataUrl: string)` — a base64 PNG data URL. Drawing scales pointer coordinates into the canvas's own coordinate space since the canvas is CSS-stretched (`w-full`) but has a fixed intrinsic size (`PAD_W=380, PAD_H=130`):
```js
const scaleX = canvas.width / rect.width;
const scaleY = canvas.height / rect.height;
return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
```
On confirm, a drawn signature is flattened onto a white background (so PNG transparency doesn't render black later in the PDF).

**5. Client-side PDF (`src/lib/agreement-pdf.ts`).** Uses `jspdf` entirely in the browser — no backend involvement. `downloadAgreementPdf()` manually lays out text with `doc.text()`, tracks a running `y` cursor, wraps text with `doc.splitTextToSize()`, and paginates via a `newPageIfNeeded(height)` helper that adds a page when the next block would overflow `PAGE_H - MARGIN`. Signature images (if present) are embedded with `doc.addImage(sig, "PNG", x, y, w, h)`; if a party hasn't signed yet, it prints "Not yet acknowledged" in place of an image.

**Frontend ↔ Backend connection:**
`src/app/agreement/page.tsx` drives the whole flow. `generate()` POSTs the full `terms` object to `/api/agreement/draft` (hits `draftAgreement` → `draftAgreementClauses`), receives `{clauses, source, error?}`, and immediately POSTs a second request to `/api/agreement/save` with `{reference, termsJson: terms, clausesJson: result.clauses, source: result.source}` (hits `saveAgreement`, which upserts and returns `{id: draft.id}` stored as `draftId`). Signing calls `submitSignature(role, dataUrl)` → POST `/api/agreement/sign` with `{draftId, role, signature: dataUrl}` (hits `signAgreement`), and a `useEffect` watching `bothSigned` fires POST `/api/agreement/deliver` with `{reference}` once both signatures exist (hits `deliverAgreement`, sends the email). PDF export and CSV export never touch the backend — they're pure client-side (`downloadAgreementPdf`, `downloadCsv`) reading state already in the component. `SharePanel` (shared with other features) POSTs to `/api/share` with `{type: "agreement", resourceId: draftId, ...}` to mint a public share link — a different, generic route not in `agreement.controller.js`.

---

## Rent Payment Logger & Activity Timeline

**Files:**
- `backend/controllers/payment.controller.js`
- `backend/services/payment.js`
- `backend/services/activity.js`
- `backend/routes/payment.routes.js`
- `src/app/profile/pay-rent-form.tsx`
- `src/components/activity-timeline.tsx`

**How it works:**

**1. `initiatePayment`.** First authorizes: the caller must have an `accepted` `Application` (tenancy) on the target listing —
```js
const tenancy = await prisma.application.findFirst({
  where: { profileId: user.profile.id, listingId, status: "accepted" },
});
if (!tenancy) return res.status(403).json({ error: "You don't have an accepted tenancy on this listing." });
```
Then it builds a unique `transactionId` (`BK-${Date.now()}-${listingId}`) and POSTs a big form (`URLSearchParams`) to SSLCOMMERZ's sandbox session-creation endpoint (`https://sandbox.sslcommerz.com/gwprocess/v4/api.php`). Note the three callback URLs it registers all point at the **backend's own** base URL (`BACKEND_URL` env var, not the frontend) — the comment explains why: SSLCOMMERZ itself calls these URLs server-to-server, so they must be reachable at the backend's public address:
```js
success_url: `${backendBaseUrl}/api/payment/ipn?status=success`,
fail_url: `${backendBaseUrl}/api/payment/ipn?status=fail`,
cancel_url: `${backendBaseUrl}/api/payment/ipn?status=cancel`,
ipn_url: `${backendBaseUrl}/api/payment/ipn`,
```
If SSLCOMMERZ approves session creation (`sslData.status === "SUCCESS"`), a `Payment` row is created with `status: "pending"`, and the controller returns `{url: sslData.GatewayPageURL, transactionId}` — the frontend redirects the whole browser tab there.

**2. The double-validation.** This is the core exam concept. There are **two independent paths** that can mark a payment paid, and both funnel into the same idempotent `finalizePayment()`:

- **Server-to-server IPN** (`paymentIpnPost`, `POST /api/payment/ipn`) — SSLCOMMERZ calls this directly from its own servers after the transaction resolves. It's deliberately unauthenticated (SSLCOMMERZ can't send a Bearer token), parsed via the global `express.urlencoded()` middleware. On a `VALID`/`VALIDATED` status it calls `finalizePayment(transactionId, validationId)`; otherwise `markFailed()`. It **always returns 200** even if finalization throws, because SSLCOMMERZ retries on non-2xx and — per the comment — the browser redirect path is a second, independent chance to finalize the same transaction anyway.
- **Browser redirect** (`paymentIpnGet`, `GET /api/payment/ipn`) — the tenant's own browser gets redirected here by SSLCOMMERZ after checkout. Also calls the same `finalizePayment()` on success, then does an HTTP redirect back to the **frontend's** origin (`FRONTEND_URL` — a different origin from the IPN's backend base, since this is a real browser navigation): `/profile?payment=success|failed|cancelled`. This path exists mainly because IPN webhooks can't reach a `localhost` dev backend — so in local dev, this redirect is the *only* path that actually fires.

- **Why idempotent (`finalizePayment` in `services/payment.js`):**
```js
export async function finalizePayment(transactionId, valId) {
  const payment = await prisma.payment.findUnique({ where: { transactionId }, include: { listing: true } });
  if (!payment) return { ok: false, reason: "not_found" };
  if (payment.status === "paid") return { ok: true, alreadyProcessed: true };
  ...
```
The very first thing it checks is whether the payment is already `"paid"` — if so it short-circuits and does nothing else. So whichever path (IPN or redirect) arrives first does the real work; whichever arrives second is a harmless no-op. This is also why the activity-log write happens *before* the (best-effort) emails: since a retry short-circuits at `status === "paid"`, if the log write happened *after* email and email failed on the first attempt, a retry would never re-reach the log write.

Before trusting anything, it independently re-validates with SSLCOMMERZ's own validator API (not just trusting the posted `status` field):
```js
const validation = valId ? await validateWithSslcommerz(valId) : null;
const isValid = !!validation &&
  (validation.status === "VALID" || validation.status === "VALIDATED") &&
  validation.tran_id === payment.transactionId &&
  Math.round(Number(validation.amount)) === payment.amount;
```
Only if all four conditions hold (fetched successfully, valid status, tran_id matches, **and the amount matches to the taka**) does it mark the payment paid, log a `payment_logged` activity event, and send a receipt email to the tenant + a confirmation email to the landlord. Otherwise it flips the payment to `"failed"` and logs `payment_failed`.

**3. Activity logging (`services/activity.js`).** Extremely small — a single `logActivity(params)` wraps `prisma.activityEvent.create()` in a try/catch that only `console.error`s on failure:
```js
export async function logActivity(params) {
  try {
    await prisma.activityEvent.create({ data: { listingId, tenantProfileId, type, actor, summary, metadata } });
  } catch (error) {
    console.error("Failed to log activity event:", params.type, error);
  }
}
```
This "best-effort, never throws" pattern is deliberate and shared with email sending — logging or notifying must never break the actual business action (payment, signing, etc.) that triggered it.

**Frontend ↔ Backend connection:**
`src/app/profile/pay-rent-form.tsx` POSTs `{listingId, amount, month}` to `/api/payment/initiate` (hits `initiatePayment`), then does a **full page redirect** (`window.location.href = data.url`) to the SSLCOMMERZ gateway page it got back — this leaves the Next.js app entirely. The tenant returns via SSLCOMMERZ's redirect to `GET /api/payment/ipn` → `paymentIpnGet` → redirected again to `/profile?payment=success` on the frontend, where `pay-rent-form.tsx`'s sibling code in `profile/page.tsx` reads the query param to show a banner (see `paymentBannerCopy`). Separately, `src/components/activity-timeline.tsx` is a pure display component — it receives an already-fetched `events: ActivityEventItem[]` array as a prop (no fetch of its own). That data actually arrives as part of the single aggregate `GET /api/profile` response, in a field `activityByListing: Record<listingId, ActivityEventItem[]>`, and `profile/page.tsx` passes `activityByListing[app.listingId]` into `<ActivityTimeline events={...} />`. So payment logging never talks to the timeline directly — both simply write/read the same `ActivityEvent` table, keyed by `listingId`/`tenantProfileId`.

**One-line note on Analytics:** Navid's Landlord/Tenant Analytics Dashboard (skipped here — not Taufiqur's feature) reads the same paid `Payment` rows (e.g. via `prisma.payment.aggregate`) to compute revenue/on-time-payment figures, so the payment logger is the sole source of truth those analytics numbers are built from.

---

## Move-Out & Final Settlement System

**Files:**
- `backend/controllers/move-out.controller.js`
- `backend/services/move-out.js`
- `backend/routes/move-out.routes.js`
- `src/components/move-out-panel.tsx`

**How it works:**

State machine on the `MoveOut` model: `proposed → acknowledged → settled`, with an `acknowledged → disputed` branch instead of confirming.

**1. `createMoveOut` (landlord only, `POST /api/move-out`).** Guards: caller must own the listing, the application must be `status === "accepted"`, and there must not already be a `moveOut` on this application (checked via the included relation). Creates the `MoveOut` row with `depositAmount` copied from the listing, immediately calls `recomputeSettlement()` to seed the settlement numbers, logs `move_out_proposed`, and emails the tenant.

**2. `updateMoveOut` (`PATCH /api/move-out/:applicationId`)** is a single endpoint branching on a zod `discriminatedUnion("action", [...])` with four actions:
- `acknowledge` — tenant only, requires `status === "proposed"`, flips to `acknowledged`, stamps `tenantAcknowledgedAt`.
- `set_deductions` — landlord only, requires `status === "acknowledged"`. Writes `deductionsJson` and — critically — **resets any existing confirmations**:
```js
await prisma.moveOut.update({
  where: { id: moveOut.id },
  data: { deductionsJson: parsed.data.deductions, landlordConfirmedAt: null, tenantConfirmedAt: null },
});
await recomputeSettlement(moveOut.id);
```
  The comment explains why: if the numbers changed after someone already confirmed, that confirmation would silently apply to different figures than what was agreed — so both confirmations are invalidated and must be redone.
- `confirm` — either tenant or landlord, requires `status === "acknowledged"`. Stamps whichever party's `*ConfirmedAt` field:
```js
const updated = await prisma.moveOut.update({
  where: { id: moveOut.id },
  data: isTenant ? { tenantConfirmedAt: now } : { landlordConfirmedAt: now },
});
if (updated.tenantConfirmedAt && updated.landlordConfirmedAt) {
  await finalizeMoveOut(moveOut.id);
  return res.json({ ok: true, settled: true });
}
```
  Only when *both* timestamps are now set does it call `finalizeMoveOut` — this is the "both parties must confirm" rule.
- `dispute` — **tenant only**, requires `status === "acknowledged"` (i.e., can only dispute a settlement that's been computed, not a bare proposal). Calls `escalateMoveOutToDispute()` instead of confirming.

**3. `recomputeSettlement` (services/move-out.js) — the actual settlement math:**
```js
export async function recomputeSettlement(moveOutId) {
  const moveOut = await prisma.moveOut.findUniqueOrThrow({ where: { id: moveOutId }, include: {...} });
  const deductions = moveOut.deductionsJson ?? [];
  const [totalRentPaid, improvementAdjustment] = await Promise.all([
    sumPaidRent(moveOut.application.listingId, moveOut.application.profileId),
    getApprovedImprovementCostAdjustment(moveOut.applicationId),
  ]);
  const depositAmount = moveOut.application.listing.deposit;
  const netRefund = Math.max(0, depositAmount - sumDeductions(deductions) + improvementAdjustment.net);
  return prisma.moveOut.update({ where: { id: moveOutId }, data: { totalRentPaid, depositAmount, netRefund } });
}
```
So: `netRefund = max(0, deposit − sum(landlord's itemized deductions) + improvementAdjustment.net)`. `totalRentPaid` is recomputed live by summing every `status: "paid"` `Payment` row for this listing+tenant (`sumPaidRent` — literally reuses the Payment Logger's own ledger, "so the two features can't drift out of sync," per the code comment) — it's displayed for transparency but doesn't itself enter the refund formula; the deposit/deductions/improvement-adjustment do. `improvementAdjustment.net` comes from the Improvement Cost Log feature (see below) — can be positive (tenant gets credited back) or negative (landlord charges more). This function is called both for a live, unconfirmed preview and again right before finalizing, so any late change (a new payment, an edited deduction, a newly-approved improvement cost) is always reflected.

**4. `finalizeMoveOut`** — runs only once both parties have confirmed. Recomputes one final time (`fresh = await recomputeSettlement(...)`), attempts a best-effort SSLCOMMERZ refund log (explicitly documented as *not* verified against a real transaction, since deposits were never collected as an SSLCOMMERZ transaction — the DB's own `refundReference`/`refundLoggedAt` fields are the real source of truth regardless of this call's outcome), then atomically:
```js
await prisma.$transaction([
  prisma.moveOut.update({ where: { id: moveOutId }, data: { status: "settled", settledAt: now, refundReference, refundLoggedAt: now } }),
  prisma.application.update({ where: { id: moveOut.applicationId }, data: { status: "completed" } }),
]);
```
Flipping `Application.status` to `"completed"` is what unlocks the Reviews feature and is the same status Navid's occupancy analytics treats as "vacant." It then logs `move_out_settled` and emails both parties a settlement summary plus the landlord a separate "your listing is vacant" email.

**5. `escalateMoveOutToDispute`** — reuses the Smart Evidence Resolution feature wholesale rather than reimplementing it: calls `buildEvidenceBundle()` and `generateDisputeAnalysis()` (from `services/dispute.js`, a different feature) to create a `Dispute` row typed `"unpaid_deposit"`, filed by the tenant, then sets `moveOut.status = "disputed"` with `disputeId` pointing at it, logs `dispute_filed`, and emails both parties.

**Frontend ↔ Backend connection:**
`src/components/move-out-panel.tsx` GETs `/api/move-out/${applicationId}` on mount (hits `getMoveOut`, which also merges in `improvementAdjustment` from `getApprovedImprovementCostAdjustment` before returning) to populate `MoveOutState`. Every button (`Propose move-out`, `Acknowledge`, `Save deductions`, `Confirm settlement`, `File dispute`) calls a shared `act(action, extra)` helper that PATCHes `/api/move-out/${applicationId}` with `{action, ...extra}` — exactly the discriminated-union shape `updateMoveOut` expects — then re-`load()`s to refresh state. The landlord's initial "Propose move-out" form instead POSTs to `/api/move-out` with `{applicationId, proposedEndDate}` (hits `createMoveOut`). The settlement numbers shown in the `<dl>` (total rent paid, deposit, deductions, improvement adjustment, net refund) are exactly the fields `recomputeSettlement` writes onto the `MoveOut` row, returned verbatim by `getMoveOut`.

---

## Vacancy & Agreement Expiry Notification System

**Files:**
- `backend/controllers/cron.controller.js`
- `backend/routes/cron.routes.js`
- `backend/middleware/cron.middleware.js`
- `backend/services/reminders.js`

*(No frontend files — this feature has no UI. It's a backend-only scheduled job. The related-but-separate Interactive Lease Timeline visualizes the same underlying dates for a human to look at, but doesn't send anything.)*

**How it works:**

**1. Trigger surface.** A single route, guarded not by user auth but by a shared secret header:
```js
// cron.middleware.js
export function requireCronSecret(req, res, next) {
  const secret = req.headers["x-cron-secret"];
  if (!secret || secret !== process.env.CRON_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}
```
```js
// cron.routes.js
cronRoutes.post("/reminders", requireCronSecret, asyncHandler(triggerScheduledReminders));
```
`triggerScheduledReminders` (the controller) is a one-liner that just calls `runScheduledReminders()` and returns its summary as JSON — all logic lives in the service. This design means an external scheduler (cron, GitHub Actions, Windows Task Scheduler) hits `POST /api/cron/reminders` with header `x-cron-secret: <CRON_SECRET>` on some interval (e.g. daily), and there's no session/browser involved at all.

**2. `runScheduledReminders(now)` in `services/reminders.js`** does two independent scans:

- **Agreement expiry (30-day and 7-day windows).** Loads every fully-signed `AgreementDraft` (`tenantSignature` and `landlordSignature` both set) for tenant-type profiles, recomputes each draft's lease end date via the shared pure function `computeLeaseEndDate(listing.availableFrom, durationMonths)`, and compares `daysBetween(now, endDate)` against exact thresholds:
```js
if (daysOut === 30 && !draft.expiry30ReminderSentAt) {
  ... send email ...
  await prisma.agreementDraft.update({ where: { id: draft.id }, data: { expiry30ReminderSentAt: now } });
  await logActivity({ type: "expiry_reminder_sent", ... });
} else if (daysOut === 7 && !draft.expiry7ReminderSentAt) {
  ... same pattern with expiry7ReminderSentAt ...
}
```
  Double-send prevention here is a **persisted timestamp column** on the draft itself (`expiry30ReminderSentAt` / `expiry7ReminderSentAt`) — once set, it's never cleared, so re-running the job any number of times on the same day (or any day after) can never re-send that specific milestone reminder for that draft. The check is `daysOut === 30` (exact equality), not `<= 30`, so a job that runs daily will only ever catch the exact day 30 (or day 7) — if the job somehow skipped a day, that reminder would be permanently missed rather than sent late.

- **Rent due in 3 days.** Computes this month's due date fixed at day 5 (`RENT_DUE_DAY = 5`, hardcoded — the same "payable by the 5th" convention that's baked into every agreement clause the AI/fallback drafter generates), and only proceeds if `daysToDue === 3` exactly:
```js
const dueDateThisMonth = new Date(now.getFullYear(), now.getMonth(), RENT_DUE_DAY);
const daysToDue = daysBetween(now, dueDateThisMonth);
if (daysToDue === 3) { ... }
```
  For each `accepted` application, it checks two things before sending — has this tenant already paid this month, and has this exact reminder already been logged:
```js
const [paidThisMonth, alreadyReminded] = await Promise.all([
  prisma.payment.findFirst({ where: { listingId, profileId, month: currentMonthLabel, status: "paid" } }),
  prisma.activityEvent.findFirst({ where: { listingId, tenantProfileId: profileId, type: "rent_due_reminder_sent", metadata: { path: ["month"], equals: currentMonthLabel } } }),
]);
if (paidThisMonth || alreadyReminded) continue;
```
  Here double-send prevention is different from the expiry case — there's no dedicated column, instead it queries the `ActivityEvent` log itself (filtering the JSON `metadata.month` field) to see if a `rent_due_reminder_sent` event already exists for this exact month. Either a payment already made, or a reminder already sent, skips that tenant.

Both scans return counters (`expiry30Sent`, `expiry7Sent`, `rentDueSent`, `checkedAgreements`, `checkedTenancies`) as the job's summary, which is exactly what `triggerScheduledReminders` sends back as the HTTP response — useful for verifying the cron actually did something when triggered manually.

**Frontend ↔ Backend connection:** None. There is no fetch call anywhere in `src/` for `/api/cron/reminders` — it's invoked purely by an external scheduler with the shared secret, not by any logged-in user's browser. A student asked to "wire up a UI for this" should recognize that would be a change in kind (adding a new, unauthenticated-by-design feature's trigger to the authenticated user-facing app), not a bug fix.

---

## Interactive Lease Timeline

**Files:**
- `backend/controllers/lease-timeline.controller.js`
- `backend/services/lease-timeline.js`
- `backend/services/lease-timeline-shared.js`
- `backend/routes/lease-timeline.routes.js`
- `src/lib/lease-timeline.ts`
- `src/components/lease-timeline-bar.tsx`
- `src/components/landlord-lease-calendar.tsx`
- `src/app/profile/page.tsx` (tenant lease timeline section)
- `src/app/landlord/page.tsx` (renewal calendar tab)

**How it works:**

**1. The pure date math — duplicated on purpose.** `backend/services/lease-timeline-shared.js` (JS) and `src/lib/lease-timeline.ts` (TS) are near-identical files: same `computeLeaseEndDate`, same `RENEWAL_WINDOW_DAYS = 30`, same `computeLeaseTimeline`. The backend file's own header comment explains the duplication:
```js
// Backend copy of src/lib/lease-timeline.ts (pure date math, no Prisma) —
// named "-shared" rather than "lease-timeline.js" to avoid colliding with
// the ported src/lib/lease-timeline.server.ts (-> services/lease-timeline.js).
// Used by services/lease-timeline.js and services/reminders.js so both
// compute the exact same lease end date from the exact same inputs.
```
The reasoning: the frontend needs this pure math client-side (no network round trip just to render a progress bar client-side wherever a timeline is already in props), while the backend needs the *same* math server-side for two different backend features — the lease timeline API itself, and independently the reminders cron job — so they can never quietly diverge (e.g. one using 30-day months and the other calendar months). Since the backend is a separate Node project (not sharing a build step with the Next.js frontend), the only way to guarantee identical logic in both runtimes is to hand-keep two copies in sync — there's no shared package here.

**2. `computeLeaseEndDate` and `computeLeaseTimeline`:**
```js
export function computeLeaseEndDate(availableFrom, durationMonths) {
  const end = new Date(availableFrom);
  end.setMonth(end.getMonth() + durationMonths);
  return end;
}
export const RENEWAL_WINDOW_DAYS = 30;
export function computeLeaseTimeline(availableFrom, durationMonths, now = new Date()) {
  const endDate = computeLeaseEndDate(availableFrom, durationMonths);
  const totalMs = Math.max(1, endDate.getTime() - availableFrom.getTime());
  const elapsedMs = now.getTime() - availableFrom.getTime();
  const renewalWindowStart = new Date(endDate.getTime() - RENEWAL_WINDOW_DAYS * DAY_MS);
  return {
    ...
    elapsedPercent: Math.min(100, Math.max(0, Math.round((elapsedMs / totalMs) * 100))),
    daysRemaining: Math.round((endDate.getTime() - now.getTime()) / DAY_MS),
    renewalWindowPercent: Math.min(100, Math.max(0, Math.round(((renewalWindowStart.getTime() - availableFrom.getTime()) / totalMs) * 100))),
    inRenewalWindow: now >= renewalWindowStart && now <= endDate,
    isExpired: now > endDate,
  };
}
```
Walk through the derivations precisely, since the prompt calls them out:
- `endDate = availableFrom + durationMonths` (via `Date.setMonth`, so it correctly rolls over year boundaries).
- `elapsedPercent` = how far through the total lease duration "now" is, as a percentage, **clamped to [0, 100]** — so a lease that hasn't started yet shows 0%, and an expired one caps at 100% rather than overshooting.
- `renewalWindowStart` = `endDate − 30 days` — literally the same 30-day threshold the reminders service uses for its first expiry email (explicitly called out in both files' comments as "not a separate, disconnected concept").
- `renewalWindowPercent` = where that 30-days-before-expiry point falls as a percentage of the total lease duration — this is what tells the UI where to start shading the "renewal window" portion of the progress bar.
- `inRenewalWindow` = boolean, true only between `renewalWindowStart` and `endDate` inclusive.
- `isExpired` = simply `now > endDate`.

**3. Backend service layer (`services/lease-timeline.js`).** Two read-only aggregation functions, no writes:
- `getTenantLeaseTimelines(profileId)` — finds every fully-signed `AgreementDraft` for this tenant profile, derives `listingId` from the reference string (same `reference.split("/")[0]` trick as the agreement feature), confirms the `Application` is still `accepted`, and returns one `computeLeaseTimeline(...)` result per active tenancy (a tenant could in theory have more than one).
- `getLandlordLeaseTimelines(landlordUserId)` — iterates every listing the landlord owns, every `accepted` application on each, finds that tenant's most-recently-created fully-signed draft, computes the timeline, and additionally attaches `tenantName` and a `renewalWindowMonthLabel` (a human month/year string derived from `timeline.renewalWindowStart`) for grouping. Sorted by `daysRemaining` ascending — soonest-expiring first.

**4. Controller/route** — trivially thin: `landlordLeaseTimelines(req, res)` just calls `getLandlordLeaseTimelines(req.user.id)` and returns JSON. There is **no tenant-facing route** in `lease-timeline.controller.js`/`routes` — the tenant's lease timeline data isn't fetched from a dedicated endpoint at all (see connection note below).

**5. `LeaseTimelineBar` (frontend, presentation-only).** Takes a `timeline: LeaseTimeline` prop and renders two overlapping absolutely-positioned bars inside a track: an accent-colored bar starting at `renewalWindowPercent%` (the renewal-decision window, drawn first so it sits underneath) and a foreground-colored bar with `width: elapsedPercent%` (progress so far, drawn on top). Below it, a status line branches on state:
```jsx
{timeline.isExpired ? (
  <span className="text-destructive">Expired {Math.abs(timeline.daysRemaining)} days ago</span>
) : timeline.elapsedDays < 0 ? (
  <span>Moves in {Math.abs(timeline.elapsedDays)} day(s)</span>
) : timeline.inRenewalWindow ? (
  <span className="text-accent">Renewal decision window — {timeline.daysRemaining} day(s) left</span>
) : (
  <span>{timeline.daysRemaining} days remaining · {timeline.elapsedPercent}% of tenancy elapsed</span>
)}
```
Four mutually-exclusive states purely derived from the fields `computeLeaseTimeline` already produced — no additional logic here.

**6. `LandlordLeaseCalendar`** fetches the landlord list, groups the flat array into a `Map<renewalWindowMonthLabel, item[]>`, and renders one section per month with a `LeaseTimelineBar` per tenancy inside it — effectively a calendar of "which properties enter their renewal window in which month."

**Frontend ↔ Backend connection:**
For the **landlord** side, `landlord-lease-calendar.tsx` GETs `/api/lease-timeline/landlord` directly (hits `landlordLeaseTimelines` → `getLandlordLeaseTimelines`), receiving an array of `LandlordLeaseTimelineItem` (the `LeaseTimeline` fields plus `applicationId`, `listingId`, `listingTitle`, `tenantName`, `renewalWindowMonthLabel`) — rendered under the landlord dashboard's "renewal calendar" tab in `src/app/landlord/page.tsx`.
For the **tenant** side, there is no separate lease-timeline fetch at all — `leaseTimelines: TenantLeaseTimelineItem[]` arrives as a field on the single aggregate `GET /api/profile` response (same call `profile/page.tsx` uses for applications, activity, etc.), and is rendered by mapping each entry into a `<LeaseTimelineBar timeline={t} />`. So the tenant's profile-page backend controller (not shown in this feature's file list, but implied) must itself call `getTenantLeaseTimelines` and fold the result into the profile aggregate.

---

## Renovation & Improvement Cost Log

**Files:**
- `backend/controllers/improvement-cost.controller.js`
- `backend/services/improvement-cost.js`
- `backend/routes/improvement-cost.routes.js`
- `src/components/improvement-cost-log.tsx`

**How it works:**

**1. Logging a cost (`createImprovementCost`, `POST /api/improvement-costs`).** Either the tenant or the landlord on an `accepted` application can log one — `loggedByRole` is derived from which one the caller is, not sent by the client:
```js
const isTenant = application.profile.userId === userId;
const isLandlord = application.listing.landlordId === userId;
if (!isTenant && !isLandlord) return res.status(403).json({ error: "Forbidden" });
if (application.status !== "accepted") return res.status(409).json({ error: "You can only log improvement costs for an active tenancy." });
```
The entry is created with `status` defaulting to `"pending"` (implicit — never set explicitly here, so it relies on the Prisma schema default) and a `settlementMethod` the logger picks from the zod enum `["deduct_from_deposit", "deduct_from_rent", "reimburse_separately"]`. An `improvement_cost_logged` activity event is logged, explicitly noting "(awaiting approval)" in the summary.

**2. Approve/reject (`decideImprovementCost`, `PATCH /api/improvement-costs/:costId`).** The key rule enforced here is that the party who logged a cost cannot also decide it:
```js
const deciderRole = isTenant ? "tenant" : "landlord";
if (deciderRole === cost.loggedByRole) {
  return res.status(403).json({ error: "The party who logged this cost can't also approve or reject it." });
}
if (cost.status !== "pending") return res.status(409).json({ error: "This entry has already been decided." });
```
This is a real check the exam might probe: it's an authorization rule based on comparing two *role* strings, not two user IDs, and it also gates on the entry not already having been decided (so an approved/rejected entry is immutable afterward — you can't approve, then later reject the same one).

If approved, and a `MoveOut` already exists on this application, it eagerly recomputes the settlement and — same invalidation pattern as `set_deductions` in the move-out service — clears any existing confirmations if either party had already confirmed, since the numbers just changed:
```js
if (newStatus === "approved" && cost.application.moveOut) {
  await recomputeSettlement(cost.application.moveOut.id);
  if (cost.application.moveOut.landlordConfirmedAt || cost.application.moveOut.tenantConfirmedAt) {
    await prisma.moveOut.update({ where: { id: cost.application.moveOut.id }, data: { landlordConfirmedAt: null, tenantConfirmedAt: null } });
  }
}
```

**3. `getApprovedImprovementCostAdjustment` (`services/improvement-cost.js`) — the actual netting logic:**
```js
export async function getApprovedImprovementCostAdjustment(applicationId) {
  const approved = await prisma.improvementCost.findMany({
    where: { applicationId, status: "approved", settlementMethod: { in: ["deduct_from_deposit", "deduct_from_rent"] } },
    select: { amount: true, loggedByRole: true },
  });
  let tenantCredit = 0;
  let landlordDebit = 0;
  for (const cost of approved) {
    if (cost.loggedByRole === "tenant") tenantCredit += cost.amount;
    else landlordDebit += cost.amount;
  }
  return { tenantCredit, landlordDebit, net: tenantCredit - landlordDebit };
}
```
This is the crux of "how the three settlement methods are handled": only `status === "approved"` entries count at all — pending or rejected entries have zero financial effect, by construction of the `where` filter. Of the three `settlementMethod` values, only two (`deduct_from_deposit`, `deduct_from_rent`) are included in this query's `in: [...]` filter — `reimburse_separately` is **excluded entirely** from this adjustment. The code comment is explicit about why: "that's the whole point of choosing it" — a landlord/tenant who picks "reimburse separately" is saying this cost should be settled outside the deposit math altogether (e.g. a direct bank transfer), so it must never silently net into `netRefund`.

For the two methods that *are* included, direction depends on who logged it, not which of the two methods was picked (both methods net identically here — the distinction between "from deposit" vs "from rent" doesn't change the *math*, only where a human expects the money to conceptually come from):
- Tenant-logged approved cost → `tenantCredit` (the tenant fronted money and should get it back) → contributes **positively** to `net`.
- Landlord-logged approved cost → `landlordDebit` (the landlord is charging the tenant) → contributes **negatively** to `net`.

That `net` value is exactly what `recomputeSettlement` in `services/move-out.js` adds into `netRefund`:
```js
const netRefund = Math.max(0, depositAmount - sumDeductions(deductions) + improvementAdjustment.net);
```
So a tenant-logged approved improvement cost *increases* the tenant's refund; a landlord-logged one *decreases* it — on top of the landlord's separately-itemized `deductionsJson` list.

**Frontend ↔ Backend connection:**
`src/components/improvement-cost-log.tsx` GETs `/api/improvement-costs?applicationId=${applicationId}` on mount (hits `getImprovementCosts`, which just authorizes tenant-or-landlord access and returns all `ImprovementCost` rows for that application, newest first) into local `costs` state. The "Log cost" form POSTs `{applicationId, title, description, amount, photoUrl, settlementMethod}` to `/api/improvement-costs` (hits `createImprovementCost`). Approve/Reject buttons — shown only when `c.status === "pending" && c.loggedByRole !== viewerRole` (mirroring the backend's "can't decide your own" rule, but only as a UI convenience; the real enforcement is server-side) — PATCH `/api/improvement-costs/${costId}` with `{action: "approve"|"reject"}` (hits `decideImprovementCost`). None of this component talks to the move-out endpoints directly; the connection to settlement math is entirely server-side, through `getApprovedImprovementCostAdjustment` being called from both `move-out.controller.js`'s `getMoveOut` (for display) and `move-out.js`'s `recomputeSettlement` (for the actual refund number) — the `MoveOutPanel` component simply displays whatever `improvementAdjustment.net` value it receives from `GET /api/move-out/:applicationId`.
