# rentFindr — Live Modification Exam: Practice Sets (with Answers)

Format mirrors the real CSE471 sample: each set has 2 tasks, each task has
2-3 sub-requirements touching both frontend and backend. Answers below are
written the way a strong student would implement them live — concrete files,
concrete code, not a full production-grade PR.

---

# NAVID MUSTAKIM ARUP

## Practice Set 1

### Task 1: Let a tenant filter search results to verified landlords with photos only

- Add a "Verified landlords only" toggle to the search filters on the homepage.
- Add a "Has photos" toggle that excludes listings with an empty `photoUrls` array.
- Show a live count next to each toggle of how many currently-loaded listings match it.

**Answer.**

This is entirely client-side — `src/app/page.tsx` already loads the full
active listing set once and filters/sorts it in a `useMemo` (see
`walkthrough-navid.md` §2). Add two boolean state vars and extend the filter
chain:

```tsx
const [verifiedOnly, setVerifiedOnly] = useState(false);
const [hasPhotosOnly, setHasPhotosOnly] = useState(false);

const results = useMemo(() => {
  return listings
    .filter((l) => (area === "Any area" ? true : l.area === area))
    .filter((l) => (roomType === "Any" ? true : l.roomType === roomType))
    .filter((l) => l.rent >= effectiveMinRent && l.rent <= effectiveMaxRent)
    .filter((l) => !availableBy || new Date(l.availableFrom) <= new Date(availableBy))
    .filter((l) => !verifiedOnly || l.landlord.verified)
    .filter((l) => !hasPhotosOnly || (l.photoUrls?.length ?? 0) > 0)
    .sort(/* unchanged */);
}, [listings, area, roomType, effectiveMinRent, effectiveMaxRent, availableBy, verifiedOnly, hasPhotosOnly, sort, matchByListingId]);
```

For the live counts, compute them against `listings` filtered by every
*other* active filter except the one the toggle controls (so the badge
reflects "how many would show if I turned this on"), or — simpler and
acceptable for exam time — just count against the currently-filtered
`results` before that specific toggle is applied:

```tsx
const verifiedCount = useMemo(
  () => listings.filter((l) => l.landlord.verified).length,
  [listings],
);
const hasPhotosCount = useMemo(
  () => listings.filter((l) => (l.photoUrls?.length ?? 0) > 0).length,
  [listings],
);
```

Render as two checkboxes/toggle chips next to the existing area/room-type
filters, each showing its count: `Verified only ({verifiedCount})`.

**No backend change needed** — `listListings` already returns `landlord.verified`
and `photoUrls` on every listing (see `walkthrough-navid.md` §2), so this is
pure frontend work. If you wanted the backend to pre-filter instead (e.g. for
pagination at scale later), you'd add to `listing.controller.js`'s `where`
clause: `...(verifiedOnly ? { landlord: { profile: { landlordVerification: { status: "verified" } } } } : {})` — but note listings don't have a direct
landlord-verified column, so this would need a relation filter through
`User → Profile → LandlordVerification`, which is why the current design
does this filter client-side instead (it already has the flattened
`landlord.verified` field from `getLandlordSummaries`).

---

### Task 2: Let an admin suspend a landlord's ability to publish Active listings

- Add a "Suspend" action for admin on a landlord's verification record, separate from reject.
- When suspended, immediately downgrade all of that landlord's Active listings to Draft.
- Block new/edited listings from going Active while suspended, and show a banner on the landlord's own dashboard.

**Answer.**

**Schema** (`backend/prisma/schema.prisma`) — add a `suspended` boolean to
`LandlordVerification` (simplest: don't touch the `status` enum, which is
verification-outcome-specific; suspension is an orthogonal admin override):

```prisma
model LandlordVerification {
  // ...existing fields...
  suspended   Boolean  @default(false)
}
```

Run `npx prisma migrate dev --name add_landlord_suspension` inside `backend/`.

**Backend** — new admin endpoint in `backend/controllers/admin.controller.js`,
following the exact pattern `reviewLandlordVerification` already uses (see
`walkthrough-navid.md` §4):

```js
export async function suspendLandlord(req, res) {
  const { verificationId } = req.params;
  const existing = await prisma.landlordVerification.findUnique({
    where: { id: verificationId },
    include: { profile: true },
  });
  if (!existing) return res.status(404).json({ error: "Not found" });

  await prisma.landlordVerification.update({
    where: { id: verificationId },
    data: { suspended: true },
  });
  // mirror the auto-promote-on-verify logic, but downgrading instead:
  await prisma.listing.updateMany({
    where: { landlordId: existing.profile.userId, status: "Active" },
    data: { status: "Draft" },
  });
  return res.json({ ok: true });
}
```

Register it in `backend/routes/admin.routes.js` alongside the existing
verification routes: `router.patch("/verifications/:verificationId/suspend", asyncHandler(suspendLandlord));`
(the router already has `requireAuth, requireRole("ADMIN")` applied at the
top per `walkthrough-navid.md`/`walkthrough-mahira.md`'s pattern notes).

**Enforce the block** — in `listing.controller.js`'s `createListing` and
`updateListing`, extend the existing verified-check to also read `suspended`:

```js
const isVerified = user.profile?.landlordVerification?.status === "verified"
  && !user.profile?.landlordVerification?.suspended;
const status = parsed.data.status === "Active" && !isVerified ? "Draft" : parsed.data.status;
```

This reuses the exact same downgrade mechanism the verified-check already
has — a suspended landlord is treated identically to an unverified one for
publishing purposes, with zero new branching logic.

**Frontend** — add a "Suspend" button next to Approve/Reject on the admin
verification review card (wherever that lives, e.g. an `admin/page.tsx`
section not covered in Navid's file list but following the same
`apiFetch(..., {method:"PATCH"})` pattern as `reviewLandlordVerification`'s
caller). On `src/app/landlord/page.tsx`, extend the existing verification
banner block (`walkthrough-navid.md` §4 shows `verificationStatus !== "verified"`
already renders a banner) to also check a new `suspended` flag returned from
`GET /api/landlord/verification`, and show `"Your account has been suspended by an admin — contact support."` instead of the normal pending/rejected copy.

---

## Practice Set 2

### Task 1: Let a tenant save multiple named match preference profiles

- Let a tenant create more than one named match preference (e.g. "For myself", "For my sister").
- Add a profile switcher (dropdown) on the Matches page.
- Recompute and re-sort match scores when the active profile changes — no extra Gemini call needed.

**Answer.**

**Schema** — currently `ListingMatchPreference` is one-per-tenant (implied
1:1 with profile, per `putMatchPreference`'s upsert-by-profileId pattern in
`walkthrough-navid.md` §5). Change it to many-per-tenant:

```prisma
model ListingMatchPreference {
  id        String  @id @default(cuid())
  profileId String
  label     String  @default("Default")
  // ...existing fields unchanged (budgetCeiling, commuteAnchorLabel, etc.)...
  @@unique([profileId, label])   // was probably @@unique([profileId]) before
}
```

Migrate with `npx prisma migrate dev --name multiple_match_preferences`.

**Backend** (`backend/controllers/match.controller.js`):
- `putMatchPreference` — accept a `label` field in the body (zod schema gets
  `label: z.string().min(1).max(40).default("Default")`), upsert on
  `{ profileId_label: { profileId, label } }` instead of `profileId` alone.
- Add `getMatchPreferences` (`GET /api/match/preferences`, plural) returning
  every saved profile for the tenant: `prisma.listingMatchPreference.findMany({ where: { profileId } })`.
- Keep the existing singular `GET /api/match/preference` for backward
  compat, or have the frontend switch to the plural endpoint entirely and
  drop the old one — either is acceptable in a live exam, state which you
  chose.

**Frontend** (`src/app/matches/page.tsx`):
```tsx
const [profiles, setProfiles] = useState<MatchPreference[]>([]);
const [activeLabel, setActiveLabel] = useState("Default");
const activeProfile = profiles.find((p) => p.label === activeLabel) ?? null;

const ranked = useMemo(() => {
  if (!activeProfile) return [];
  return listings
    .map((listing) => ({ listing, result: matchScore(activeProfile, listing) }))
    .sort((a, b) => b.result.total - a.result.total);
}, [listings, activeProfile]);
```
Because `matchScore` (Feature 5, `src/lib/match.ts`) is pure client-side
math with no network call, switching `activeLabel` via a `<select>` and
re-deriving `ranked` via the `useMemo` dependency array is instant — exactly
why the duplicate client-side scoring copy exists in the first place (see
`walkthrough-navid.md` §5's "why the duplicate exists" section). No Gemini
call is triggered by switching profiles — "Why this matches" explanations
are still fetched on-demand per listing-click regardless of which profile
is active.

---

### Task 2: Add a "Trust Score improving/declining" indicator to the landlord dashboard

- Compare this month's Trust Score to last month's using the already-computed 6-month trend.
- Show an up/down arrow with the point difference next to the score.
- If it dropped more than 10 points, add it as an auto-generated insight sentence.

**Answer.**

**No new query needed** — `getLandlordAnalytics` already returns
`trust: { score, breakdown, trend }` where `trend` is a `TrustPoint[]` of
6 monthly points computed by `trustTrend()` (see `walkthrough-navid.md` §3).
The last two points *are* this-month and last-month.

**Backend** (`backend/services/analytics.js`, inside `getLandlordAnalytics`,
after `trend` is computed):
```js
const trend = await trustTrend((asOf) => landlordTrustComponents(landlordUserId, asOf), 6);
const [prevPoint, currentPoint] = trend.slice(-2);
const trustDelta =
  prevPoint?.score != null && currentPoint?.score != null
    ? currentPoint.score - prevPoint.score
    : null;

if (trustDelta != null && trustDelta <= -10) {
  insights.push(`Your Trust Score dropped ${Math.abs(trustDelta)} points this month — check recent maintenance response times and payment records.`);
}

return {
  // ...existing fields...
  trust: { score, breakdown, trend, delta: trustDelta },
};
```
This reuses `weightedScore`/`landlordTrustComponents` with zero new logic —
the "renormalize around missing data" behavior (§3) already means `delta`
correctly comes back `null` rather than a misleading number if either month
lacks enough data to compute a score at all.

**Frontend** (`src/components/analytics-dashboard.tsx`), next to the
existing Trust Score display:
```tsx
{data.trust.delta != null && (
  <span className={data.trust.delta >= 0 ? "text-trust-high" : "text-destructive"}>
    {data.trust.delta >= 0 ? "▲" : "▼"} {Math.abs(data.trust.delta)}
  </span>
)}
```
The auto-generated sentence appears automatically in the existing `insights`
list rendering — no separate UI needed for it, since `insights` is already
mapped to `<li>` elements.

---

# MD TAUFIQUR RAHMAN

## Practice Set 1

### Task 1: Let a landlord issue a partial rent waiver for a specific month

- Let a landlord mark one specific month as "waived" for a tenant (no payment expected that month).
- Show a "Waived" badge on the tenant's payment history, distinct from paid/failed.
- Exclude waived months entirely from the on-time payment rate calculation (neither a hit nor a miss).

**Answer.**

**Schema** — extend `Payment.status` to allow a new value. If it's a plain
string column (not a Prisma enum) this is a zero-migration change; if it's
a Prisma `enum PaymentStatus`, add `waived` to it and migrate:
```prisma
enum PaymentStatus {
  pending
  paid
  failed
  waived
}
```

**Backend** — new endpoint in `backend/controllers/payment.controller.js`,
landlord-only, sibling to `initiatePayment`:
```js
export async function waiveRent(req, res) {
  const { listingId, profileId, month } = waiveSchema.parse(req.body);
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.landlordId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const payment = await prisma.payment.upsert({
    where: { listingId_profileId_month: { listingId, profileId, month } }, // needs a compound unique — add if not present
    update: { status: "waived" },
    create: { listingId, profileId, month, amount: 0, status: "waived", transactionId: `WAIVE-${Date.now()}` },
  });
  await logActivity({
    listingId, tenantProfileId: profileId, type: "rent_waived", actor: "landlord",
    summary: `Landlord waived rent for ${month}.`,
  });
  return res.json(payment);
}
```
Register `POST /api/payment/waive` in `backend/routes/payment.routes.js`.

**The on-time-rate exclusion** is the part worth being careful with — it
appears in *two* places that must both change consistently (per
`walkthrough-navid.md` §6's note that tenant history and Trust Score
deliberately reuse the exact same ratio):
- `backend/services/tenant-history.js` (`onTimePaymentRate`)
- `backend/services/analytics.js` (`landlordTrustComponents`'s `payment` component)

Both currently do roughly `paid / total`. Change both to filter out waived
payments from `total` entirely before computing the ratio:
```js
const countable = payments.filter((p) => p.status !== "waived");
const rate = countable.length
  ? Math.round((countable.filter((p) => p.status === "paid").length / countable.length) * 100)
  : null;
```

**Frontend** (`src/app/profile/pay-rent-form.tsx` or wherever payment
history renders — likely inside the applications list in `profile/page.tsx`):
add a badge branch: `p.status === "waived" ? <span className="text-muted-foreground">Waived</span> : ...`.
On the landlord side (`move-out-panel.tsx`'s sibling landlord view, or a new
small form), add a "Waive this month" button that POSTs `{listingId, profileId, month}`
to `/api/payment/waive`.

---

### Task 2: Let a tenant download a PDF summary of a settled move-out

- Add a "Download settlement PDF" button once a move-out reaches `settled`.
- Include total rent paid, deposit, itemized deductions, improvement cost adjustment, and net refund.
- Disable the button (with an explanatory tooltip) if the move-out isn't settled yet.

**Answer.**

This is **entirely client-side** — no backend change needed at all, since
`GET /api/move-out/:applicationId` already returns every field required
(`totalRentPaid`, `depositAmount`, `deductionsJson`, `improvementAdjustment`,
`netRefund` — see `walkthrough-taufiqur.md`'s Move-Out section). This
mirrors the existing pattern in `src/lib/agreement-pdf.ts`, which is pure
`jspdf` in the browser with no backend involvement.

**New file** `src/lib/settlement-pdf.ts`, following `agreement-pdf.ts`'s
exact structure (running `y` cursor, `newPageIfNeeded`):
```ts
import { jsPDF } from "jspdf";
import type { MoveOutState } from "@/components/move-out-panel";

export function downloadSettlementPdf(state: MoveOutState, listingTitle: string) {
  const doc = new jsPDF();
  let y = 20;
  doc.setFontSize(16);
  doc.text(`Move-Out Settlement — ${listingTitle}`, 14, y);
  y += 12;
  doc.setFontSize(11);
  const lines = [
    ["Total rent paid", bdt(state.totalRentPaid)],
    ["Security deposit", bdt(state.depositAmount)],
    ...state.deductionsJson.map((d) => [`Deduction — ${d.description}`, `-${bdt(d.amount)}`]),
    ["Improvement adjustment", bdt(state.improvementAdjustment.net)],
    ["Net refund", bdt(state.netRefund)],
  ];
  for (const [label, value] of lines) {
    doc.text(`${label}: ${value}`, 14, y);
    y += 8;
  }
  doc.save(`settlement-${listingTitle}.pdf`);
}
```

**In `move-out-panel.tsx`**, add the button next to the existing settlement
display, gated on status:
```tsx
<button
  type="button"
  disabled={state.status !== "settled"}
  title={state.status !== "settled" ? "Available once the settlement is finalized" : undefined}
  onClick={() => downloadSettlementPdf(state, listingTitle)}
>
  Download settlement PDF
</button>
```
The `disabled` + `title` combo is the standard way this codebase already
handles conditional actions (compare to how Accept/Decline buttons on the
landlord applicant list are disabled once a decision is made — same pattern,
just a tooltip instead of changed button text).

---

## Practice Set 2

### Task 1: Let a landlord customize the rent-due day per listing

- Add a "Rent due day" field (1–28) to the listing create/edit form.
- Use that per-listing value instead of the hardcoded day-5 assumption when computing the 3-day rent-due reminder.
- Show the actual due day on the tenant's payment form instead of assuming the 5th.

**Answer.**

**Schema**: add `rentDueDay Int @default(5)` to the `Listing` model, migrate.

**Backend — listing controller**: add `rentDueDay: z.number().int().min(1).max(28).default(5)`
to both `createListingSchema` and `updateListingSchema` in
`backend/controllers/listing.controller.js`, and include it in the
`prisma.listing.create`/`update` `data` object — purely additive, no other
logic in that controller changes.

**Backend — reminders service** (`backend/services/reminders.js`), the
part that currently hardcodes `RENT_DUE_DAY = 5` for every tenancy (see
`walkthrough-taufiqur.md`'s Vacancy & Expiry section) needs to loop
per-listing instead of using one global due date:
```js
// before: one dueDateThisMonth computed once, used for every application
// after: compute per-listing, using that listing's own rentDueDay
for (const application of acceptedApplications) {
  const dueDay = application.listing.rentDueDay; // was the hardcoded constant
  const dueDateThisMonth = new Date(now.getFullYear(), now.getMonth(), dueDay);
  const daysToDue = daysBetween(now, dueDateThisMonth);
  if (daysToDue !== 3) continue;
  // ...rest of the existing paid-check / already-reminded-check / send logic, unchanged...
}
```
This is a real "read the existing loop structure and slot in a per-row value
where a global constant used to sit" change — the double-send-prevention
logic (`ActivityEvent` lookup keyed by month) doesn't need to change at all,
since it was already per-tenancy.

**Frontend**: add a numeric input (1–28) to the listing form in
`src/app/landlord/page.tsx`'s `emptyForm`/`Field` block, next to `availableFrom`.
On `src/app/profile/pay-rent-form.tsx`, replace any hardcoded "due by the
5th" copy with `Due by the {listing.rentDueDay}{ordinalSuffix(listing.rentDueDay)}` —
pull `rentDueDay` from the listing data already available on the application
object (no new fetch needed, since applications already join their listing).

---

### Task 2: Let a landlord attach a photo to an agreement and embed it in the PDF

- Let a landlord upload a photo (e.g. a floor plan) while drafting an agreement.
- Store it with the draft and show a thumbnail in the review UI.
- Embed it as its own page in the exported PDF.

**Answer.**

**Schema**: add `attachmentUrl String?` to `AgreementDraft` (stores a base64
data URL, same convention as listing photos / landlord documents elsewhere
in this codebase — no new upload infrastructure needed).

**Backend** (`backend/controllers/agreement.controller.js`): extend
`saveAgreement`'s zod schema with `attachmentUrl: z.string().max(MAX_PHOTO_CHARS).optional()`
(reuse the same `MAX_PHOTO_CHARS` constant pattern used for listing photos),
and include it in the upsert's `create`/`update` data. No change needed to
`draftAgreement` or `signAgreement` — the attachment isn't part of AI
drafting or signature authorization, it's just an extra stored field.

**Frontend — draft UI** (`src/app/agreement/page.tsx`): add a file input
next to the existing form fields, convert to base64 with the same
`fileToBase64` pattern already used elsewhere (`src/app/landlord/page.tsx`
has this exact helper — copy it or extract to a shared `src/lib/file.ts`),
include `attachmentUrl` in the `POST /api/agreement/save` body, and render
`<img src={attachmentUrl} className="h-24 w-32 object-cover" />` as a
thumbnail once set.

**PDF embedding** (`src/lib/agreement-pdf.ts`): following the exact pattern
already used for signature images (`doc.addImage(sig, "PNG", x, y, w, h)`,
per `walkthrough-taufiqur.md`'s agreement section), add a new page for the
attachment at the end:
```ts
if (draft.attachmentUrl) {
  doc.addPage();
  doc.setFontSize(14);
  doc.text("Attachment", MARGIN, 20);
  doc.addImage(draft.attachmentUrl, "PNG", MARGIN, 30, PAGE_W - MARGIN * 2, 150);
}
```
Since `attachmentUrl` is an arbitrary uploaded image, detect its actual
format (`data:image/jpeg` vs `data:image/png`) from the data URL prefix and
pass the right format string to `addImage` — jsPDF's `addImage` requires it
to match.

---

# MAHIRA TUN ALIA

## Practice Set 1

### Task 1: Let a tenant pin an important message for quick reference

- Let a tenant mark any message in a thread as "Pinned" from the message list.
- Add a "Pinned messages" panel at the top of the thread view.
- Auto-pin any message Gemini already flagged, without the user needing to pin it manually.

**Answer.**

**Schema**: add `pinned Boolean @default(false)` to the `Message` model,
migrate.

**Backend** (`backend/controllers/message.controller.js`): add a small
endpoint, following the existing party-scoped authorization pattern
`createMessage` already uses (see `walkthrough-mahira.md` §5):
```js
export async function togglePin(req, res) {
  const { messageId } = req.params;
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { application: { include: { profile: true, listing: true } } },
  });
  if (!message) return res.status(404).json({ error: "Not found" });
  const isParty =
    message.application.profile.userId === req.user.id ||
    message.application.listing.landlordId === req.user.id;
  if (!isParty) return res.status(403).json({ error: "Forbidden" });

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { pinned: !message.pinned },
  });
  return res.json({ pinned: updated.pinned });
}
```
Register `PATCH /api/messages/:messageId/pin` in `message.routes.js`.

**Auto-pin on flag**: the natural place is inside `moderateAndNotify` in
`message.controller.js` — right where it currently does
`await prisma.message.update({ where: {id}, data: {flagged: true, flagReason} })`
after a positive `flagMessage()` result (see `walkthrough-mahira.md` §5),
just add `pinned: true` to that same update call — zero new logic, one
extra field on an update that already happens:
```js
if (result.flagged) {
  await prisma.message.update({
    where: { id: message.id },
    data: { flagged: true, flagReason: result.reason, pinned: true },
  });
  // ...existing activity log + email...
}
```

**Frontend** (`src/app/messages/[applicationId]/page.tsx`): add a pin
button/icon per message that calls `apiFetch(\`/api/messages/${id}/pin\`, {method:"PATCH"})`
then reloads the thread (same `await load()` pattern the send-message flow
already uses). Render a "Pinned" section above the main thread by filtering
already-loaded messages: `messages.filter((m) => m.pinned)` — no extra fetch
needed, since the full thread (including `pinned`/`flagged` fields once you
add `pinned` to whatever `select`/response shape `listMessages` returns) is
already loaded in one call.

---

### Task 2: Let a landlord set a custom SLA deadline per maintenance request

- Let the landlord set a custom response deadline (in hours) when acknowledging a request, overriding the default 48 hours.
- Show an "SLA remaining" countdown to both parties.
- If the custom deadline is missed, flag it Overdue using that custom deadline, not the default.

**Answer.**

**Schema**: add `customSlaHours Int?` to `MaintenanceRequest`.

**Backend** (`backend/services/maintenance.js`): the core function needs to
accept an override instead of always using the constant (see
`walkthrough-mahira.md` §2 for the original):
```js
export const MAINTENANCE_SLA_HOURS = 48;

export function isOverdue(status, createdAt, customSlaHours) {
  if (status === "resolved") return false;
  const slaHours = customSlaHours ?? MAINTENANCE_SLA_HOURS;
  const deadline = new Date(createdAt).getTime() + slaHours * 60 * 60 * 1000;
  return Date.now() > deadline;
}
```
Every call site in `maintenance.controller.js` that currently does
`isOverdue(m.status, m.createdAt)` needs the third argument added:
`isOverdue(m.status, m.createdAt, m.customSlaHours)` — this touches all four
endpoints (`getMaintenanceRequests`, `createMaintenanceRequest`,
`getLandlordMaintenanceRequests`, `updateMaintenanceRequestStatus`), per
the walkthrough's note that `isOverdue` is recomputed fresh in every one of
them.

**Setting it**: extend `updateMaintenanceRequestStatus`'s zod schema to
accept an optional `customSlaHours` only when transitioning *to*
`acknowledged` (matches the task's "when acknowledging" requirement):
```js
if (parsed.data.status === "acknowledged" && parsed.data.customSlaHours) {
  data.customSlaHours = parsed.data.customSlaHours;
}
```

**Frontend** (`src/app/maintenance/page.tsx`, `LandlordView`): when the
"Acknowledge" button is clicked, prompt for an optional custom-hours number
(a small inline input rather than a modal, for exam-time simplicity) and
include it in the PATCH body. For the countdown, compute
`hoursRemaining = (deadline - Date.now()) / 3_600_000` client-side from
`createdAt` + `(customSlaHours ?? 48)` and render it as text, updating on
each render (no need for a live ticking timer for exam purposes — re-render
on any state change is enough, or add a `setInterval` for a true live
countdown if time allows).

---

## Practice Set 2

### Task 1: Let a tenant permanently hide a specific roommate candidate

- Let a tenant hide one specific candidate from their matching results (a persistent block).
- Add a "Hidden candidates" list on the roommates page with an un-hide action.
- Exclude hidden candidates from any future saved matching session for that tenant.

**Answer.**

**Schema**: new join table, since this is a many-to-many "tenant blocks
tenant" relationship:
```prisma
model RoommateHide {
  id             String   @id @default(cuid())
  hidingProfileId String
  hiddenProfileId String
  createdAt      DateTime @default(now())
  @@unique([hidingProfileId, hiddenProfileId])
}
```

**Backend** (`backend/controllers/roommate.controller.js`), two small
endpoints following the exact toggle pattern `toggleSaveListing` already
uses elsewhere in the codebase (see `walkthrough-navid.md` §7):
```js
export async function hideCandidate(req, res) {
  const { candidateProfileId } = req.body;
  await prisma.roommateHide.upsert({
    where: { hidingProfileId_hiddenProfileId: { hidingProfileId: profile.id, hiddenProfileId: candidateProfileId } },
    update: {},
    create: { hidingProfileId: profile.id, hiddenProfileId: candidateProfileId },
  });
  return res.json({ ok: true });
}

export async function unhideCandidate(req, res) {
  const { candidateProfileId } = req.params;
  await prisma.roommateHide.deleteMany({
    where: { hidingProfileId: profile.id, hiddenProfileId: candidateProfileId },
  });
  return res.json({ ok: true });
}
```
Then modify `listRoommateCandidates` (the existing endpoint, per
`walkthrough-mahira.md` §1) to exclude hidden ones:
```js
const hidden = await prisma.roommateHide.findMany({
  where: { hidingProfileId: profile.id },
  select: { hiddenProfileId: true },
});
const hiddenIds = hidden.map((h) => h.hiddenProfileId);
const candidates = await prisma.profile.findMany({
  where: { accountType: "tenant", id: { notIn: [profile.id, ...hiddenIds] } },
  // ...existing include of roommatePreference...
});
```
Add a separate `GET /api/roommates/hidden` returning the hidden list (joined
with display names) for the "Hidden candidates" panel.

**Frontend** (`src/app/roommates/page.tsx`): add a "Hide" button per
candidate card that POSTs to the hide endpoint then removes that candidate
from local `candidates` state (or re-fetches). Add a collapsible "Hidden
candidates (N)" section that fetches `/api/roommates/hidden` and offers
"Un-hide" per row. Since `listRoommateCandidates` already excludes hidden
profiles server-side, **saved sessions automatically respect this** the
next time a session is computed — no change needed to `compatibility()`
itself or to `POST /api/roommates/session`, since a saved session's
`results` array is only ever built from whatever `candidates` array was
loaded, and that array is now pre-filtered.

---

### Task 2: Let an admin request more evidence before resolving a dispute

- Let an admin request additional evidence (a note + optional photo) from the filer, instead of resolving immediately.
- Add a status label (Open / Evidence Requested / Resolved) visible to both parties and the admin.
- When the tenant submits the requested evidence, re-run the Gemini analysis including it, and notify the admin by email.

**Answer.**

**Schema**: extend `Dispute` with an evidence-request state and a place to
store the follow-up evidence:
```prisma
model Dispute {
  // ...existing fields...
  status              String   @default("open") // "open" | "evidence_requested" | "resolved"
  evidenceRequestNote String?
  additionalEvidence  Json?    // { note: string, photoUrl?: string, submittedAt: DateTime }
}
```

**Backend** (`backend/controllers/dispute.controller.js`):

New admin action, following the exact atomic-update-with-status-guard
pattern `resolveDispute` already uses (see `walkthrough-mahira.md` §4):
```js
export async function requestEvidence(req, res) {
  const { disputeId } = req.params;
  const { note } = requestEvidenceSchema.parse(req.body);
  const { count } = await prisma.dispute.updateMany({
    where: { id: disputeId, status: "open" },
    data: { status: "evidence_requested", evidenceRequestNote: note },
  });
  if (count === 0) return res.status(409).json({ error: "This dispute is not open." });
  // email the filer, similar to disputeNotificationEmail
  return res.json({ ok: true });
}
```

Filer's submission — **must re-run the exact same `generateDisputeAnalysis`
call** used at filing time (§4), now passing in the extra evidence appended
to the bundle text:
```js
export async function submitAdditionalEvidence(req, res) {
  const { disputeId } = req.params;
  const { note, photoUrl } = additionalEvidenceSchema.parse(req.body);
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (dispute.status !== "evidence_requested") {
    return res.status(409).json({ error: "No evidence request is pending." });
  }
  const additionalEvidence = { note, photoUrl, submittedAt: new Date() };
  const updatedBundle = { ...dispute.evidenceJson, additionalEvidence };

  const analysis = await generateDisputeAnalysis(updatedBundle, dispute.type, dispute.description, dispute.filedByRole);

  await prisma.dispute.update({
    where: { id: disputeId },
    data: {
      status: "open", // back to open, now admin can resolve with better info
      additionalEvidence,
      aiSummary: analysis.summary,
      aiInconsistencies: analysis.inconsistencies,
      aiSuggestedSplit: analysis.suggestedSplit,
      aiSource: analysis.source,
    },
  });
  // email the admin that new evidence arrived
  return res.json({ ok: true });
}
```
Note this reuses `generateDisputeAnalysis` completely unchanged — it's
already a pure function of `(bundle, type, description, filedByRole)`, so
feeding it a bundle with one extra field (`additionalEvidence`) just means
that text shows up in the same flattened prompt the function already builds
(§4's description of how the bundle gets turned into prose lines for
Gemini) — no changes needed inside `dispute.js` itself.

**Frontend** (`src/app/disputes/[disputeId]/page.tsx`): render the status
label from `dispute.status` (three states instead of two). If
`status === "evidence_requested"` and the viewer is the filer, show a small
form (note textarea + optional photo upload, same base64 pattern as
everywhere else) that POSTs to the new submit-evidence endpoint. If the
viewer is admin and `status === "open"`, add a "Request more evidence"
button alongside the existing resolve form, calling the new
`requestEvidence` endpoint with a note field.
