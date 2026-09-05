# Mahira's Features — Live Modification Exam Study Guide

This document walks through the real, current code for each feature Mahira owns. Read the code excerpts closely — an examiner can ask you to trace a value from the frontend all the way into the database, or ask "what happens if X" and expect you to point at the exact line that handles it.

---

## 1. Roommate Compatibility Matching

**Files:**
- `backend/controllers/roommate.controller.js`
- `backend/routes/roommate.routes.js`
- `src/app/roommates/page.tsx`
- `src/data/module1.ts`
- `src/components/share-panel.tsx`
- `src/components/export-settings.tsx`

**How it works:**

The backend for this feature is intentionally "dumb" — it never scores anything. It just stores and serves preference data. All five endpoints live in `roommate.controller.js` and are mounted at `/api/roommates` (see `app.use("/api/roommates", roommateRoutes)` in `backend/app.js`):

- `PUT /api/roommates/preference` (`putRoommatePreference`) — validates the tenant's own roommate profile (budget, sleep, smoking, smokingNonNegotiable, cooking, study, visitors) against a zod schema and **upserts** it:

```js
const preference = await prisma.roommatePreference.upsert({
  where: { profileId: profile.id },
  update: parsed.data,
  create: { profileId: profile.id, ...parsed.data },
});
```

- `GET /api/roommates/preference` — returns the caller's own saved preference (or `null`) so the frontend can pre-fill the form.
- `GET /api/roommates/candidates` (`listRoommateCandidates`) — returns *every other tenant's* saved preference (excluding the caller's own profile, and filtered to `accountType: "tenant"` / `role: "TENANT"`), including each candidate's email and `memberSince` date. This is raw data — no scores attached.
- `POST /api/roommates/session` / `GET /api/roommates/session` — lets a tenant save a whole "matching session" (their profile + the computed results array) as a `RoommateSession` row, so it can be revisited from `/profile` or shared via the SharePanel.

**The actual scoring algorithm lives entirely on the frontend**, in `src/data/module1.ts`, in the `compatibility()` function:

```ts
export function compatibility(a: RoommateProfile, b: RoommateProfile) {
  const hardBlocked =
    (a.smokingNonNegotiable || b.smokingNonNegotiable) &&
    ((a.smoking === "Yes" && b.smoking === "No") || (b.smoking === "Yes" && a.smoking === "No"));

  const budget = Math.max(0, 1 - Math.abs(a.budget - b.budget) / Math.max(a.budget, b.budget));
  const sleep = scale(["Early", "Flexible", "Late"], a.sleep, b.sleep);
  const smoking = scale(["No", "Tolerant", "Yes"], a.smoking, b.smoking);
  const study = scale(["Quiet", "Mixed", "Social"], a.study, b.study);
  const visitors = scale(["Rare", "Occasional", "Frequent"], a.visitors, b.visitors);

  const parts = [
    { label: "Budget overlap", weight: 30, value: budget },
    { label: "Sleep schedule", weight: 20, value: sleep },
    { label: "Smoking preference", weight: 20, value: smoking },
    { label: "Study habits", weight: 15, value: study },
    { label: "Visitor tolerance", weight: 15, value: visitors },
  ];

  const total = Math.round(parts.reduce((s, p) => s + p.weight * p.value, 0));
  return { total: hardBlocked ? 0 : total, parts, hardBlocked };
}
```

Walk through the math carefully — **the weights here are 30/20/20/15/15, not 30/20/20/15/15+15 for both study and visitor** (the task brief mentioned "study 15%, visitor tolerance 15%" which matches; note cooking is *not* scored even though it's collected — the comment above the function explicitly says so).

Each factor's `value` is a 0–1 similarity score:
- **Budget** (30 weight): `1 - |a.budget - b.budget| / max(a.budget, b.budget)`, clamped at 0. This is a *relative* gap — two people with budgets 5000 vs 5500 differ by 500/5500 ≈ 9%, giving value ≈ 0.91. If budgets are identical, value = 1 (perfect).
- **Sleep / Smoking / Study / Visitors**: each uses the shared `scale()` helper:

```ts
const scale = <T extends string>(order: T[], a: T, b: T) => {
  const d = Math.abs(order.indexOf(a) - order.indexOf(b));
  return Math.max(0, 1 - d / (order.length - 1));
};
```

This treats each category as an ordered scale (e.g. `["Early", "Flexible", "Late"]`) and measures how far apart the two answers are as *steps* on that scale, normalized to 0–1. Adjacent values (Early vs Flexible) score 0.5 (since `1 - 1/2`); opposite ends (Early vs Late) score 0 (since `1 - 2/2`); identical values score 1.

Each part's contribution to the final score is `weight * value` (e.g. a perfect budget match contributes the full 30 points; a half-matched sleep schedule contributes 20 × 0.5 = 10). The `total` is the rounded sum of all five contributions, capped at 100 since weights sum to 100.

**The hard-block rule** overrides everything: if *either* person marked smoking as non-negotiable AND one smokes ("Yes") while the other flatly refuses ("No"), `hardBlocked` is true and `total` is forced to 0 regardless of how well everything else matched. Note this only fires on a Yes/No collision — a "Tolerant" person paired with a "No, non-negotiable" person is *not* hard-blocked (only scaled down via the normal `smoking` factor).

The `roommates/page.tsx` page computes matches client-side with `useMemo`:

```ts
const matches = useMemo(
  () =>
    candidates
      .map((c) => ({ candidate: c, result: compatibility(profile, c) }))
      .sort((a, b) => b.result.total - a.result.total),
  [profile, candidates],
);
```

Every time the user drags a slider or picks a choice, `profile` state updates, `compatibility()` re-runs against all fetched candidates, and the list re-sorts by score — entirely on the client, with zero extra network calls per comparison.

The **share panel** (`src/components/share-panel.tsx`) is generic — it POSTs `{ type: "roommate_session", resourceId, recipientEmail?, recipientName? }` to `/api/share` to mint a secure, expiring (7-day) link, and can DELETE `/api/share` with `{ token }` to revoke it. It's only enabled once a session has been saved (`disabled={!savedSessionId}`).

The **export settings** (`src/components/export-settings.tsx`) is also generic: it renders a fields-checklist + score-format picker (`number` / `percent` / `label`, via `formatScore()`/`scoreLabel()` — Strong ≥85, Mixed ≥70, else Thin), then calls back into the page's `onDownloadCsv`/`onDownloadPdf` handlers, which build a `Record<string,string>[]` of rows from `matches` and hand them to `downloadCsv()` (raw CSV Blob download) or `downloadSimplePdf()` (a jsPDF-based simple label/value renderer).

**Frontend ↔ Backend connection:**
On mount, `roommates/page.tsx` calls `apiFetch("/api/roommates/preference")` (→ `getRoommatePreference`) to pre-fill the form if the user has saved one before, and `apiFetch("/api/roommates/candidates")` (→ `listRoommateCandidates`) to get the raw candidate list, mapping each `CandidateApiResponse` (`profileId, displayName, email, memberSince, budget, sleep, smoking, smokingNonNegotiable, cooking, study, visitors`) into the page's local `Candidate` type. Saving preferences calls `PUT /api/roommates/preference` with the full `RoommateProfile` JSON body (→ `putRoommatePreference`, upserts `RoommatePreference`). Saving a session calls `POST /api/roommates/session` with `{ label, profileData, results: [{candidateId, score, breakdown}] }` (→ `createRoommateSession`, stored as JSON blobs on `RoommateSession`). At no point does the backend compute or validate a compatibility score — that logic exists only in `compatibility()` on the client.

---

## 2. Maintenance Request Tracker with SLA

**Files:**
- `backend/controllers/maintenance.controller.js`
- `backend/routes/maintenance.routes.js`
- `backend/services/maintenance.js`
- `backend/services/gmail.js` (`maintenanceFiledEmail`, `maintenanceStatusEmail`)
- `src/app/maintenance/page.tsx`

**How it works:**

The SLA math is deliberately tiny and lives in `backend/services/maintenance.js`:

```js
export const MAINTENANCE_SLA_HOURS = 48;

export function isOverdue(status, createdAt) {
  if (status === "resolved") return false;
  const deadline = new Date(createdAt).getTime() + MAINTENANCE_SLA_HOURS * 60 * 60 * 1000;
  return Date.now() > deadline;
}
```

A request is "overdue" if it isn't resolved yet and more than 48 hours have elapsed since it was *filed* (`createdAt`), not since its last status change. Note this is a pure function computed on read, every time — there's no cron job or stored "overdue" flag; `isOverdue()` is called fresh inside every controller response (`getMaintenanceRequests`, `createMaintenanceRequest`, `getLandlordMaintenanceRequests`, `updateMaintenanceRequestStatus`) so the flag is always current at request time.

The lifecycle is a 4-state machine: `pending → acknowledged → in_progress → resolved`. `createMaintenanceRequest` (`POST /api/maintenance`) is tenant-only, and gated to only work on an active tenancy:

```js
if (application.profile.userId !== req.user.id) {
  return res.status(403).json({ error: "Forbidden" });
}
if (application.status !== "accepted") {
  return res.status(409).json({
    error: "You can only file maintenance requests for an active tenancy.",
  });
}
```

`updateMaintenanceRequestStatus` (`PATCH /api/maintenance/:requestId`) is landlord-only (checked via `maintenanceRequest.application.listing.landlordId !== req.user.id`), accepts only one of the three forward states via a zod enum, and stamps the matching timestamp column:

```js
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
```

There's no validation preventing skipping states or going backward in the controller itself — the frontend enforces the linear progression by only ever offering the *next* step (see below), but the API itself would accept e.g. `pending → resolved` directly if called out of order.

Both mutating endpoints fire an email as a side effect (each wrapped in `.catch(() => {})` so a failed email never breaks the request): filing notifies the landlord via `maintenanceFiledEmail`, and every status change notifies the tenant via `maintenanceStatusEmail`. Both are awaited (unlike the messaging feature's fire-and-forget pattern — see Feature 5), so email delivery does add latency to these responses, but a failed send is swallowed rather than surfaced.

On the frontend, `src/app/maintenance/page.tsx` branches into two totally different views based on role:

- **`TenantView`**: loads the tenant's `accepted` applications from `/api/applications/mine`, lets them pick which tenancy to file against, and submits a form (title, description, optional base64-encoded photo capped at 1.5MB client-side) to `POST /api/maintenance`.
- **`LandlordView`**: loads every request across all their listings from `/api/maintenance/landlord`, and renders a single "next step" button per request driven by:

```ts
const nextStep: Partial<Record<Status, { label: string; next: Status }>> = {
  pending: { label: "Acknowledge", next: "acknowledged" },
  acknowledged: { label: "Start progress", next: "in_progress" },
  in_progress: { label: "Mark resolved", next: "resolved" },
};
```

This map is what actually enforces the strictly-forward, one-step-at-a-time lifecycle in the UI — `resolved` has no entry, so the button disappears once resolved. Overdue requests get a red border/badge, and the header shows a running `overdueCount`.

**Frontend ↔ Backend connection:**
Tenant flow: `apiFetch("/api/maintenance?applicationId=…")` (GET, `getMaintenanceRequests`) returns `TenantRequest[]` including a computed `isOverdue` boolean; `apiFetch("/api/maintenance", { method: "POST", body: {applicationId, title, description, photoUrl} })` hits `createMaintenanceRequest`, which 403/409-guards then creates a `MaintenanceRequest` row and emails the landlord. Landlord flow: `apiFetch("/api/maintenance/landlord")` (GET, `getLandlordMaintenanceRequests`) returns a flattened `LandlordRequest[]` (joined with listing title and tenant display name); `apiFetch("/api/maintenance/:id", { method: "PATCH", body: {status} })` hits `updateMaintenanceRequestStatus`, which re-derives `isOverdue` server-side on its own response so the UI's badge state matches the DB immediately after the mutation.

---

## 3. Mutual Review & Rental Reputation System + Categorized Review Ratings

**Files:**
- `backend/controllers/review.controller.js`
- `backend/routes/review.routes.js`
- `backend/services/reviews.js`
- `src/components/review-panel.tsx`

**How it works:**

The category sets are role-asymmetric and defined in `backend/services/reviews.js`:

```js
export const LANDLORD_REVIEW_CATEGORIES = [
  { key: "responsiveness", label: "Responsiveness" },
  { key: "listingAccuracy", label: "Listing accuracy" },
  { key: "maintenanceQuality", label: "Maintenance quality" },
];

export const TENANT_REVIEW_CATEGORIES = [
  { key: "paymentPunctuality", label: "Payment punctuality" },
  { key: "propertyCare", label: "Property care" },
  { key: "communication", label: "Communication" },
];

export function categoriesForRatee(rateeIsLandlord) {
  return rateeIsLandlord ? LANDLORD_REVIEW_CATEGORIES : TENANT_REVIEW_CATEGORIES;
}

export function overallFromCategories(categoryRatings) {
  const values = Object.values(categoryRatings);
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}
```

The category set is chosen by **who is being rated, not who's doing the rating**: a landlord is always rated on responsiveness/listing accuracy/maintenance quality; a tenant is always rated on payment punctuality/property care/communication. So when a tenant writes a review, they're scoring the landlord and must submit `LANDLORD_REVIEW_CATEGORIES` keys; when a landlord writes a review, they score the tenant and must submit `TENANT_REVIEW_CATEGORIES` keys. `overallFromCategories` is simply the arithmetic mean of the (1–5) category scores, rounded to the nearest integer — that rounded mean becomes the review's single `rating` field.

In `review.controller.js`, `createReview` (`POST /api/reviews`) enforces this pairing server-side, building two separate zod schemas up front:

```js
const landlordCategorySchema = z.object(
  Object.fromEntries(LANDLORD_REVIEW_CATEGORIES.map((c) => [c.key, z.number().int().min(1).max(5)])),
);
const tenantCategorySchema = z.object(
  Object.fromEntries(TENANT_REVIEW_CATEGORIES.map((c) => [c.key, z.number().int().min(1).max(5)])),
);
```

and then picking the right one based on the caller's role relative to the application:

```js
const categorySchema = isTenant ? landlordCategorySchema : tenantCategorySchema;
const categoryParsed = categorySchema.safeParse(parsed.data.categoryRatings);
if (!categoryParsed.success) {
  return res.status(400).json({ error: "Invalid category ratings for this role." });
}
```

If a tenant tries to submit `paymentPunctuality` ratings (the tenant-rating-a-tenant categories) instead of `responsiveness`/etc, this schema rejects it outright with 400 — you cannot rate "yourself's own category set."

**The completion gate** (the core of "Mutual Review"): reviews can only be created once the tenancy's `application.status === "completed"`:

```js
if (application.status !== "completed") {
  return res.status(409).json({ error: "Reviews unlock once this tenancy has ended." });
}
```

This is checked *before* the category-schema branching, so an active (`accepted`) tenancy can't be reviewed at all yet, regardless of role. The review is unique per `(applicationId, raterProfileId)` at the DB level — a duplicate attempt hits a Prisma `P2002` unique-constraint error, caught and turned into a friendly 409 ("You've already reviewed this tenancy.") rather than a 500.

`getReviews` (`GET /api/reviews?applicationId=`) returns both sides' reviews for one tenancy, tagging each with `raterIsTenant: r.raterProfileId === application.profileId` so the frontend can tell "my review" from "their review" without knowing the viewer's own profile ID. `getReceivedReviews` (`GET /api/reviews/received`) aggregates *all* reviews the logged-in user has ever received (as a tenant across their applications, and as a landlord across their listings) and computes a plain average (`sum(rating)/count`) — this is the reputation number shown elsewhere on a profile.

On the frontend, `review-panel.tsx` picks its category set the same way as the backend:

```ts
const categories = categoriesForRatee(viewerIsTenant);
```

Note the naming is intentionally about the *ratee*: if the viewer is a tenant, they're rating the landlord, so `categoriesForRatee(true)` returns `LANDLORD_REVIEW_CATEGORIES` (matches `rateeIsLandlord ? LANDLORD... : TENANT...` — passing `viewerIsTenant` works here because "viewer is tenant" implies "ratee is landlord"). Each category gets a 1–5 star picker defaulting to 5, `POST`ed with an optional free-text comment. Once loaded, it looks for `myReview` (matching the viewer's own tenant/landlord side) and `otherReview` and renders whichever exist — the submit form is replaced by "Your review" once submitted, since the one-review-per-side rule means there's nothing left to submit.

**Frontend ↔ Backend connection:**
`ReviewPanel` calls `GET /api/reviews?applicationId=…` (`getReviews`) on mount, receiving `Review[]` with `{id, rating, comment, categoryRatings, createdAt, raterIsTenant, raterName}`. Submitting calls `POST /api/reviews` with `{applicationId, categoryRatings, comment?}` (`createReview`), which 409s if the tenancy isn't `completed`, 400s on wrong-role category keys, computes `rating` via `overallFromCategories`, and persists a `Review` row keyed by `(applicationId, raterProfileId)`.

---

## 4. ★ Smart Evidence Resolution (flagship feature)

**Files:**
- `backend/controllers/dispute.controller.js`
- `backend/routes/dispute.routes.js`
- `backend/services/dispute.js`
- `backend/services/gmail.js` (`disputeNotificationEmail`, `disputeFiledConfirmationEmail`, `disputeResolvedEmail`)
- `src/app/disputes/page.tsx`
- `src/app/disputes/[disputeId]/page.tsx`
- `src/lib/disputes.ts`

**How it works:**

This feature has two halves: an **evidence bundler** that gathers everything about a tenancy into one JSON snapshot, and a **Gemini-powered analyzer** that reads that bundle and produces a non-binding opinion.

### `buildEvidenceBundle(applicationId)` — `backend/services/dispute.js`

This runs five queries in parallel (`Promise.all`) and assembles one object:

```js
const [landlordUser, agreementDrafts, payments, maintenance, activity, flaggedMessages] =
  await Promise.all([
    prisma.user.findUnique({ where: { id: application.listing.landlordId } }),
    prisma.agreementDraft.findMany({
      where: { profileId: application.profileId, reference: { startsWith: `${application.listingId}/` } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payment.findMany({ where: { listingId: application.listingId, profileId: application.profileId }, orderBy: { createdAt: "asc" } }),
    prisma.maintenanceRequest.findMany({ where: { applicationId }, orderBy: { createdAt: "asc" } }),
    prisma.activityEvent.findMany({ where: { listingId: application.listingId, tenantProfileId: application.profileId }, orderBy: { createdAt: "asc" } }),
    prisma.message.findMany({ where: { applicationId, flagged: true }, orderBy: { createdAt: "asc" } }),
  ]);
```

Piece by piece, what it gathers:
- **Signed agreement by reference**: it doesn't just grab "the agreement" — it fetches all `AgreementDraft` rows for this profile whose `reference` starts with `${listingId}/` (agreement references are namespaced per listing), then picks the strongest evidence:

```js
const agreementDraft =
  agreementDrafts.find((d) => d.tenantSignature && d.landlordSignature) ?? agreementDrafts[0];
```

It prefers a **fully-signed** draft (both `tenantSignature` and `landlordSignature` present) as the legal anchor, but falls back to the most recent draft if none is fully signed — so an agreement still shows up even if signing never completed, rather than showing nothing.
- **Payment history**: every `Payment` row for this listing+profile, in chronological order — month, amount, status, timestamp.
- **Maintenance timeline**: every `MaintenanceRequest` for this application, each annotated with its own `isOverdue` computed inline (re-implementing the same 48-hour rule as `services/maintenance.js`: `Date.now() - m.createdAt.getTime() > 48 * 60 * 60 * 1000`).
- **Flagged messages only** — not the full thread: `prisma.message.findMany({ where: { applicationId, flagged: true } })`. The comment above the function is explicit about why: "Only Gemini-flagged messages are included (not the full thread)... ordinary back-and-forth isn't evidence." This ties directly into Feature 5's `flagMessage` — a message only shows up here if the messaging moderation scan already tagged it.
- **Activity timeline**: every `ActivityEvent` logged against this listing+tenant (dispute filings, resolutions, message flags, etc. — a general audit log used across the app).

The final bundle shape is a flat object with `application`, `listing`, `tenant`, `landlord`, `agreement`, `payments[]`, `maintenance[]`, `activity[]`, `flaggedMessages[]` — this exact shape is what gets stored verbatim as `evidenceJson` on the `Dispute` row (a frozen snapshot at filing time) and is what the frontend's evidence bundle UI renders directly.

### `generateDisputeAnalysis(bundle, type, description, filedByRole)` — `backend/services/dispute.js`

If `GEMINI_API_KEY` isn't set, it short-circuits to a fallback immediately (`fallbackAnalysis("Gemini is not configured.")`) — the fallback shape is always `{ summary, inconsistencies: [], suggestedSplit: null, source: "fallback", error? }`, so the frontend never has to special-case "no AI" vs "AI available."

The prompt (built as a joined array of strings) instructs Gemini very specifically:

```js
const prompt = [
  "You are assisting an admin mediating a landlord-tenant rental dispute in Bangladesh.",
  "Compare the filer's claim against the platform's stored evidence record below. Do not invent facts not present in the record.",
  'Return strict JSON: {"summary": string, "inconsistencies": string[], "suggestedSplit": string | null}.',
  '"summary" is 2-4 sentences describing what the evidence shows relative to the claim.',
  '"inconsistencies" lists specific, concrete mismatches between the claim and the record (e.g. a claimed non-payment on a date the record shows a logged payment). Empty array if none found.',
  '"suggestedSplit" is one short sentence proposing a starting-point responsibility split (e.g. "Landlord 30% / Tenant 70%, based on...") or null if the evidence is too thin to suggest one. This is explicitly a non-binding starting point, not a verdict...',
  ...
].join("\n");
```

It then flattens the entire evidence bundle into readable prose lines appended after the instructions (property details, agreement signing status, every payment/maintenance/flagged-message/activity entry inline as text) — so Gemini gets the *whole* bundle as context, not just the claim. This is the model call:

```js
const genAI = new GoogleGenerativeAI(key);
const model = genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" });
const response = await model.generateContent(prompt);
```

The three things it returns, exactly as asked in the schema:
1. **`summary`** — a 2–4 sentence description of what the evidence shows relative to the claim.
2. **`inconsistencies`** — an array of concrete mismatches between the claim text and the stored record (empty array if none).
3. **`suggestedSplit`** — one tentative sentence proposing a starting-point responsibility percentage split, or `null` if there isn't enough evidence to suggest one.

The raw response text is stripped of markdown code fences (```json wrappers Gemini sometimes adds) before `JSON.parse`, then validated against a zod schema (`analysisShapeSchema`) — if Gemini returns malformed/unexpected JSON, it falls back rather than crashing. Errors are further classified (429 rate-limit vs 403/PERMISSION_DENIED vs generic) to give the fallback a more useful `error` message.

### Controller logic — `dispute.controller.js`

`createDispute` (`POST /api/disputes`) requires the tenancy to be `accepted` or `completed` (you can't dispute a tenancy that never started), builds the bundle, runs the analysis, and stores everything as a snapshot on creation — meaning **the AI analysis is generated once, at filing time**, not regenerated later:

```js
const bundle = await buildEvidenceBundle(application.id);
const analysis = await generateDisputeAnalysis(bundle, parsed.data.type, parsed.data.description, isTenant ? "tenant" : "landlord");

const dispute = await prisma.dispute.create({
  data: {
    applicationId: application.id,
    filedByProfileId: filerProfileId,
    filedByRole: isTenant ? "tenant" : "landlord",
    type: parsed.data.type,
    description: parsed.data.description,
    evidenceJson: bundle,
    aiSummary: analysis.summary,
    aiInconsistencies: analysis.inconsistencies,
    aiSuggestedSplit: analysis.suggestedSplit,
    aiSource: analysis.source,
  },
});
```

It also emails both the filer (confirmation) and the counterparty (notification), and logs a `dispute_filed` activity event.

**The admin-only one-shot resolution** is `resolveDispute` (`PATCH /api/disputes/:disputeId`), gated by `requireRole("ADMIN")` at the route level. The interesting part is the race-condition guard — it doesn't trust the earlier read-then-check, it re-checks status *inside* the write itself:

```js
const { count } = await prisma.dispute.updateMany({
  where: { id: disputeId, status: "open" },
  data: {
    status: "resolved",
    resolution: parsed.data.resolution,
    resolvedByUserId: req.user.id,
    resolvedAt: new Date(),
  },
});
if (count === 0) {
  return res.status(409).json({ error: "This dispute has already been resolved." });
}
```

This is the "one-shot" guarantee: `updateMany` with `status: "open"` in the WHERE clause means only the first of two concurrent PATCH requests (e.g. a double-click, or two admin tabs open) actually matches and updates a row; the second gets `count === 0` and is rejected with 409 instead of silently overwriting the first admin's resolution text. After a successful resolve, it logs a `dispute_resolved` activity event and emails both tenant and landlord with the resolution text via `disputeResolvedEmail`.

`getDispute` (`GET /api/disputes/:disputeId`) is open to any party (tenant, landlord, or admin — checked in `loadWithAccess`), but includes a `canResolve: isAdmin && dispute.status === "open"` flag in its response, which the frontend uses to decide whether to show the resolution form at all.

**Frontend ↔ Backend connection:**

`src/app/disputes/page.tsx` (filing UI): loads the caller's eligible tenancies (`accepted`/`completed` for tenants, or all for landlords) from `/api/applications/mine` or `/api/applications/landlord`, and the caller's dispute history from `GET /api/disputes/mine` (→ `getMyDisputes`, returns a list view with `{id, type, status, createdAt, filedByRole, filedByName, listingTitle}`). Filing submits `POST /api/disputes` with `{applicationId, type, description}` (→ `createDispute`), where `type` is constrained to the four values in `DISPUTE_TYPE_LABEL` from `src/lib/disputes.ts` (`unlawful_eviction`, `unpaid_deposit`, `property_damage`, `other`) via the `<select>` populated from `Object.entries(typeLabel)`.

`src/app/disputes/[disputeId]/page.tsx` (evidence bundle + resolution UI): calls `GET /api/disputes/:disputeId` (→ `getDispute`) which returns the full `DisputeDetail` shape including `evidence` (the frozen `evidenceJson` bundle — agreement/payments/maintenance/flaggedMessages/activity, rendered as separate cards), `aiSummary`/`aiInconsistencies`/`aiSuggestedSplit`/`aiSource` (rendered in the "AI evidence summary" panel), and `canResolve`. If `canResolve` is true and status is `"open"`, it renders a resolution `<textarea>` that submits `PATCH /api/disputes/:disputeId` with `{resolution}` (→ `resolveDispute`); if already `"resolved"`, it shows the stored `resolution` and `resolvedAt` instead. Note `flaggedMessages` is read defensively (`ev.flaggedMessages ?? []`) because disputes filed before this field existed won't have it in their frozen snapshot.

---

## 5. In-Platform Messaging

**Files:**
- `backend/controllers/message.controller.js`
- `backend/routes/message.routes.js`
- `backend/services/messaging.js`
- `backend/services/gmail.js` (`newMessageEmail`)
- `src/app/messages/page.tsx`
- `src/app/messages/[applicationId]/page.tsx`

**How it works:**

`createMessage` (`POST /api/messages`) is party-scoped (tenant or landlord on the application only), blocked on declined applications, and — critically — inserts the message and returns a response to the sender **before** the Gemini moderation scan even starts:

```js
const message = await prisma.message.create({
  data: {
    applicationId: application.id,
    senderProfileId,
    senderRole: isTenant ? "tenant" : "landlord",
    body: parsed.data.body,
  },
  include: { sender: { select: { displayName: true } } },
});

// Fire-and-forget — do NOT await; see moderateAndNotify's comment above.
moderateAndNotify(message, application, isTenant, parsed.data.body).catch(console.error);

return res.status(201).json({
  id: message.id, senderRole: message.senderRole, senderName: message.sender.displayName,
  body: message.body, flagged: message.flagged, flagReason: message.flagReason, createdAt: message.createdAt,
});
```

**Why it's not awaited**: the comment block above `moderateAndNotify` explains it directly — the Gemini flag scan is a full network round-trip (often 1–3+ seconds), and it used to sit in the response path, making every message send feel sluggish. On the old Next.js backend this was solved with `after()` (run code after the response is flushed); Express has no built-in equivalent, so the fix here is simpler: just don't `await` the promise, and let Node's long-lived process keep executing it in the background (no serverless-cutoff risk, unlike on Vercel/Next). The practical consequence: the message the sender just typed shows up in their own UI as `flagged: false` immediately, and if it later gets flagged, that only becomes visible on the thread's *next* fetch (a re-poll or reload), not on the send response itself.

`moderateAndNotify` does two things once it eventually runs: calls `flagMessage(body)`, and if flagged, updates the message row and logs a `message_flagged` `ActivityEvent` — this is the exact mechanism that feeds Feature 4's evidence bundle (`buildEvidenceBundle`'s `flaggedMessages` query only picks up messages where `flagged: true`). It also sends `newMessageEmail` to the counterparty regardless of flag status.

### `flagMessage(body)` — `backend/services/messaging.js`

This is the actual Gemini prompt for detecting the three key terms the task described:

```js
const prompt = [
  "You are scanning a single message sent between a landlord and a tenant on a Bangladeshi rental platform.",
  "Flag it only if it contains one of: an implied or explicit rent change, a move-out notice or stated intent to vacate, or a payment promise/commitment (e.g. paying by a specific date).",
  "Do not flag ordinary conversation, questions, or small talk.",
  'Return strict JSON: {"flagged": boolean, "reason": string | null}.',
  '"reason" is a short (under 12 words) description of what was flagged, or null if not flagged.',
  "",
  `Message: "${body}"`,
].join("\n");
```

So the three trigger categories are exactly: **rent change**, **move-out notice / intent to vacate**, and **payment promise/commitment**. The response is expected as strict JSON `{flagged, reason}`, parsed the same way as the dispute analyzer (strip ```json fences, `JSON.parse`, validate with a zod schema `flagShapeSchema`).

**Fail-safe behavior**: if `GEMINI_API_KEY` isn't set, or the API call throws, or the response doesn't parse into the expected shape, the function returns `{ flagged: false, reason: null }` — never an error, never a thrown exception:

```js
try {
  ...
  const parsed = flagShapeSchema.safeParse(JSON.parse(text));
  if (!parsed.success) return { flagged: false, reason: null };
  return parsed.data;
} catch {
  return { flagged: false, reason: null };
}
```

The doc-comment above the function states the reasoning directly: "a message send must never fail or block just because Gemini is slow/unconfigured/erroring, so any failure here quietly resolves to 'not flagged' rather than surfacing an error to the sender." Combined with the fire-and-forget call site, this means moderation is best-effort and additive — it can only ever add a flag, never block or delay a send.

`listThreads` (`GET /api/messages/threads`) builds an inbox by finding every non-declined `Application` the caller is a party to (as tenant via their profile, or as landlord via `listing.landlordId`), each annotated with its most recent message (`messages: { orderBy: {createdAt:"desc"}, take: 1 }`) and a total `_count.messages`. `listMessages` (`GET /api/messages?applicationId=`) returns the full ordered thread for one application, each message including its `flagged`/`flagReason` fields.

**Frontend ↔ Backend connection:**
`src/app/messages/page.tsx` (inbox) calls `GET /api/messages/threads` (→ `listThreads`) and renders each `Thread` (`applicationId, status, listingTitle, listingArea, counterpartyName, messageCount, lastMessage`) as a link to `/messages/[applicationId]`. `src/app/messages/[applicationId]/page.tsx` (thread view) loads both `GET /api/messages?applicationId=…` (→ `listMessages`, full `Message[]`) and `GET /api/messages/threads` in parallel (to get the counterparty/listing header info by filtering the threads list for the current `applicationId`). Sending a message calls `POST /api/messages` with `{applicationId, body}` (→ `createMessage`), and on success just reloads the whole thread (`await load()`) — there's no optimistic UI or websocket push, so a flagged status only appears after that reload picks up whatever `moderateAndNotify` finished in the background. The UI renders a flag banner (`⚑ Flagged for evidence — {reason}`) directly from the `flagged`/`flagReason` fields once they're present.
