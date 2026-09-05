# Navid Mustakim Arup — Live Modification Exam Study Guide

General wiring you need to know before anything else: the frontend never talks to the database directly. Every frontend call goes through `src/lib/api-client.ts`'s `apiFetch(path, options)`, which reads a JWT out of `localStorage` (`rentfindr_token`), attaches it as `Authorization: Bearer <token>`, and fetches `${NEXT_PUBLIC_API_URL}${path}` (defaults to `http://localhost:4000`). Routes are mounted in `backend/app.js`, e.g. `app.use("/api/listings", listingRoutes)`, `app.use("/api/match", matchRoutes)`, `app.use("/api/analytics", analyticsRoutes)`, `app.use("/api/admin", adminRoutes)`, `app.use("/api/landlord", landlordRoutes)`, `app.use("/api/applications", applicationRoutes)`.

---

## 1. Property Listing Management with Trust Signals

**Files:**
- `backend/controllers/listing.controller.js` (`createListing`, `updateListing`, `getListing`, `getListingDetail`)
- `backend/routes/listing.routes.js`
- `backend/services/landlord-summary.js`
- `src/app/landlord/page.tsx` (Listings tab: create/edit form + table)
- `src/app/listings/[listingId]/page.tsx`
- `src/app/listings/[listingId]/listing-detail.tsx`
- `src/components/trust.tsx`

**How it works:**

A listing is created via `POST /api/listings`. Before touching the DB, `createListing` re-fetches the user with their profile and `landlordVerification` and rejects anyone who isn't a landlord:

```js
const isLandlord = user?.role === "LANDLORD" || user?.profile?.accountType === "landlord";
if (!user || !isLandlord) {
  return res.status(403).json({ error: "Only landlord accounts can create listings." });
}
```

The payload is validated with a Zod schema (`createListingSchema`) — room type is an enum of exactly 4 strings, `photoUrls` is capped at 6 entries and ~2.2M chars each (base64 images), `houseRules` at 15 entries.

The trust-signal enforcement is the core logic: **only an admin-verified landlord can publish an Active listing.** Even if the form says "Active", the server silently downgrades it to "Draft" if the landlord isn't verified:

```js
const isVerified = user.profile?.landlordVerification?.status === "verified";
const status = parsed.data.status === "Active" && !isVerified ? "Draft" : parsed.data.status;
```

The response includes `downgradedToDraft: parsed.data.status === "Active" && status === "Draft"` so the frontend can show a specific "saved as draft" notice rather than silently hiding the listing. `updateListing` repeats the exact same verification check (it re-reads `req.user.id`'s verification status on every edit — a landlord who gets un-verified after posting can no longer keep new/edited listings Active). Ownership is enforced by comparing `existing.landlordId !== req.user.id` and returning 403 otherwise.

Two read endpoints matter here. `getListing` (`GET /api/listings/:listingId`) returns the raw listing plus applicant count and a `landlord` summary object, used by the landlord's own "edit" flow. `getListingDetail` (`GET /api/listings/:listingId/detail`) is a **newer, public-facing endpoint** — the comment in the code explains why it exists: the original Next.js app queried Prisma directly from a server component, but now that the frontend has no DB access, this single endpoint bundles the raw listing + the landlord's *public* profile + property history in one round trip:

```js
export async function getListingDetail(req, res) {
  const { listingId } = req.params;
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) return res.status(404).json({ error: "Listing not found" });
  const [owner, history] = await Promise.all([
    getLandlordPublicProfile(listing.landlordId),
    getPropertyHistory(listing.id),
  ]);
  return res.json({ listing, owner, history });
}
```

The trust-signal data itself comes from `backend/services/landlord-summary.js`. `getLandlordSummaries(landlordIds)` batches a lookup across many landlords at once (used by the search results list, which needs a summary per listing without an N+1 query): it fetches all matching `User`s (with `profile.landlordVerification`) and all their `Listing`s in two parallel queries, then folds listing counts into a `Map` before merging in verification status:

```js
const verified = verification?.status === "verified";
map.set(u.id, {
  id: u.id, name: u.name ?? "Landlord", verified,
  verifiedSince: verified && verification?.reviewedAt ? formatDate(verification.reviewedAt.toISOString()) : null,
  totalListings: agg.totalListings, totalApplicants: agg.totalApplicants,
});
```

`getLandlordPublicProfile` (used only by `getListingDetail`) extends that base summary with `completedRentals`, `avgResponseHours`, `lastActiveLabel` (from `getLandlordTrustSignals` in `trust-signals.js`) and the landlord's uploaded `LandlordDocument`s — this is deliberately a *separate* function from `getLandlordSummary` so the lighter-weight summary path (used everywhere else) isn't forced to also compute response-time trust signals it doesn't need.

**Frontend ↔ Backend connection:** The landlord desk's "Listings" tab (`src/app/landlord/page.tsx`) calls `apiFetch("/api/listings/mine")` on mount (→ `getMyListings`, not one of the 4 you're asked about but adjacent) to populate the table, and `apiFetch(\`/api/listings/${listingId}\`)` inside `startEdit()` (→ `getListing`) to prefill the edit form. `submitListing()` does `POST /api/listings` (create) or `PATCH /api/listings/${editingId}` (update, → `updateListing`), sending a JSON body shaped exactly like `createListingSchema`/`updateListingSchema` (title, area, city, latitude/longitude, rent, deposit, roomType, availableFrom, status, houseRules as string array, photoUrls as base64 data-URL strings, optional sqft). It reads back `data.downgradedToDraft` and shows the "kept as a draft" banner if true. On the public side, `src/app/listings/[listingId]/page.tsx` is a **React Server Component** (not `apiFetch`) that does a plain `fetch(`${API_URL}/api/listings/${listingId}/detail`, { cache: "no-store" })` at request time on the server, then passes the parsed `{ listing, owner, history }` down as props into the client component `ListingDetail` (`listing-detail.tsx`), which renders the `owner.verified`/`VerifiedBadge` trust badge (from `src/components/trust.tsx`) and the documents list directly from that payload — it does no further fetching for that data itself (it separately calls `/api/listings/save` and `/api/applications/mine` for save/apply state).

---

## 2. Smart Tenant Search & Ranked Application System

**Files:**
- `backend/controllers/listing.controller.js` (`listListings`)
- `backend/controllers/application.controller.js`
- `src/app/page.tsx`
- `src/app/landlord/page.tsx` (`rankedApplications` useMemo + applicant list)

**How it works:**

`listListings` (`GET /api/listings`, no auth required) is the backend half of search. It only ever returns `status: "Active"` listings, and builds a Prisma `where` clause by conditionally spreading in filters — a pattern worth understanding because it's used everywhere in this codebase:

```js
where: {
  status: "Active",
  ...(area ? { area } : {}),
  ...(roomType ? { roomType } : {}),
  ...(minRentNum !== undefined || maxRentNum !== undefined
    ? { rent: { ...(minRentNum !== undefined ? { gte: minRentNum } : {}), ...(maxRentNum !== undefined ? { lte: maxRentNum } : {}) } }
    : {}),
  ...(availableByDate ? { availableFrom: { lte: availableByDate } } : {}),
},
orderBy: { postedOn: "desc" },
```

Each filter key is entirely absent from `where` unless the query param was actually supplied — an empty object `{}` spread is a no-op, so `?minRent=5000` alone doesn't force `maxRent`. Rent bounds are parsed with `Number(...)` and rejected with 400 if not `Number.isFinite`. The result is enriched with `_count.applications` (Prisma relation count) and then merged with `getLandlordSummaries(...)` so every listing carries `landlord.verified`/`landlord.totalApplicants` for sorting/badging.

**All of the actual searching, filtering, and sorting UI logic is client-side**, in `src/app/page.tsx`. The backend only pre-filters to `status: "Active"`; the frontend fetches the *entire* active listing set once (`apiFetch("/api/listings")`) and then does area/room-type/rent/date filtering and sort entirely in a `useMemo`:

```js
const results = useMemo(() => {
  return listings
    .filter((l) => (area === "Any area" ? true : l.area === area))
    .filter((l) => (roomType === "Any" ? true : l.roomType === roomType))
    .filter((l) => l.rent >= effectiveMinRent && l.rent <= effectiveMaxRent)
    .filter((l) => !availableBy || new Date(l.availableFrom) <= new Date(availableBy))
    .sort((a, b) =>
      sort === "match" && matchByListingId
        ? (matchByListingId.get(b.id) ?? 0) - (matchByListingId.get(a.id) ?? 0)
        : sort === "rent"
          ? a.rent - b.rent
          : Number(b.landlord.verified) - Number(a.landlord.verified) ||
            b.landlord.totalApplicants - a.landlord.totalApplicants,
    );
}, [listings, area, roomType, effectiveMinRent, effectiveMaxRent, availableBy, sort, matchByListingId]);
```

Three sort modes: `"verified"` (default) ranks verified landlords first, then by `totalApplicants` descending as a tiebreak; `"rent"` is a plain ascending numeric sort; `"match"` (only offered as an option if the tenant has saved match preferences) sorts by the client-computed Personalized Match Score (see Feature 5) descending. Note the rent-slider bounds themselves are derived from the *actual* loaded listings (`Math.min(4000, ...rents)` / `Math.max(20000, ...rents)`) — this is explicitly commented as a fix so a hardcoded slider ceiling can never make a real, more-expensive listing permanently unreachable.

On the "ranked application" side, once a tenant applies (`createApplication`, `POST /api/applications`), the important server-side guarantee is duplicate-prevention done *twice*: a fast `findFirst` check for a friendly error, but the actual guarantee is the DB's `@@unique([profileId, listingId])` constraint — the code explicitly says the `findFirst` isn't atomic with the `create`, so it catches Prisma's `P2002` unique-violation error code and turns it into the same clean 409:

```js
try {
  const application = await prisma.application.create({ data: { profileId: user.profile.id, listingId: parsed.data.listingId, note: parsed.data.note, status: "submitted" } });
  return res.json(application);
} catch (err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return res.status(409).json({ error: "You have already applied for this listing." });
  }
  throw err;
}
```

`listApplicationsForListing` (`GET /api/applications?listingId=`) is landlord-only (it 404s if `listing.landlordId !== req.user.id`, deliberately masking "forbidden" as "not found") and attaches each applicant's `getTenantHistorySummaries` result as `history`.

The actual **ranking** of applicants happens entirely client-side in `src/app/landlord/page.tsx`'s `rankedApplications` `useMemo` — it is NOT a backend sort:

```js
const rankedApplications = useMemo(() => {
  const verifiedRank = (a: RealApplication) =>
    a.profile.tenantVerification?.status === "verified" ? 0 : 1;
  return [...applications].sort(
    (a, b) =>
      verifiedRank(a) - verifiedRank(b) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}, [applications]);
```

This is a two-key sort: verified tenants (rank 0) always come before unverified (rank 1); within the same verification tier, earlier applications come first (ascending `createdAt`). The rendered list then numbers applicants `01`, `02`, ... in that ranked order and shows each one's `history` panel (confirmed tenancies, on-time payment rate, disputes resolved/total) inline.

**Frontend ↔ Backend connection:** `src/app/page.tsx` calls `apiFetch("/api/listings")` once on mount → `listListings`, which returns an array of listings each already carrying `landlord: { verified, totalApplicants, ... }` and `_count.applications`; all further filtering/sorting of that array is client work, no additional network calls per filter change. `src/app/landlord/page.tsx` calls `apiFetch(\`/api/applications?listingId=${selected}\`)` whenever the selected listing changes → `listApplicationsForListing`, which returns each `Application` row with nested `profile` (`roommatePreference`, `tenantVerification`) and a computed `history` object; the frontend never asks the backend to sort or rank these — `rankedApplications` re-derives the display order locally every time `applications` changes. Accept/decline actions go through `PATCH /api/applications/${id}` (`updateApplicationStatus`) with `{ status }`.

---

## 3. Landlord & Tenant Analytics Dashboard

**Files:**
- `backend/controllers/analytics.controller.js`
- `backend/services/analytics.js`
- `src/components/analytics-dashboard.tsx`

**How it works:**

The controller is a thin pass-through: `landlordAnalytics` calls `getLandlordAnalytics(req.user.id)`; `tenantAnalytics` first resolves the caller's `Profile` row, then calls `getTenantAnalytics(profile.id)`. All the real logic is in `backend/services/analytics.js`.

**Trust Score weighted average.** The weights live in `backend/services/module1.js`:

```js
export const TRUST_WEIGHTS = [
  { key: "payment",      weight: 0.25 },
  { key: "maintenance",  weight: 0.20 },
  { key: "disputes",     weight: 0.20 },
  { key: "verification", weight: 0.15 },
  { key: "reviews",      weight: 0.10 },
  { key: "agreements",   weight: 0.10 },
];
```

These sum to 1.0. `weightedScore(breakdown)` in `analytics.js` computes the score, but its key design decision is **renormalizing around missing data instead of defaulting a missing component to 0 or 100**:

```js
export function weightedScore(breakdown) {
  let weightSum = 0;
  let scoreSum = 0;
  for (const w of TRUST_WEIGHTS) {
    const v = breakdown[w.key];
    if (v == null) continue;
    weightSum += w.weight;
    scoreSum += v * w.weight;
  }
  if (weightSum === 0) return null;
  return Math.round(scoreSum / weightSum);
}
```

If, say, `disputes` is always `null` (there's no dispute-resolution outcome model in the schema — see below), its 0.20 weight is dropped entirely from both the numerator and denominator, so the remaining 5 components' weights are implicitly rescaled to sum to 1.0 among themselves — the score is never artificially dragged down by a component the platform can't actually measure yet.

**Component math** (`landlordTrustComponents(landlordUserId, asOf)`), each is a 0–100 percentage or `null` if there's no data:
- `payment`: `% of that landlord's payments with status "paid"`.
- `maintenance`: `%` of resolved maintenance requests where `(resolvedAt - createdAt) <= MAINTENANCE_SLA_HOURS` (imported from `maintenance.js`).
- `disputes`: **always `null`** — the code comment is explicit: `"no dispute/resolution model exists in this schema yet"`. This is a real gap you should be ready to explain if asked — the weight table advertises it, but it can never contribute a score.
- `verification`: `100` if the landlord's `LandlordVerification.status === "verified"`, `0` if `"rejected"`, `null` if no row/still pending.
- `reviews`: average star rating × 20 (mapping 1–5 stars to 20–100), but only over reviews where the *rater* is the tenant on that application (i.e. reviews the landlord *received*, not ones they wrote):
  ```js
  const landlordReviews = reviews.filter((r) => r.raterProfileId === r.application.profileId);
  const reviewScore = landlordReviews.length ? Math.round(avg(landlordReviews.map((r) => r.rating)) * 20) : null;
  ```
- `agreements`: `%` of that landlord's `accepted`/`completed` applications whose status is specifically `"completed"` (i.e. leases that ran their course rather than being merely accepted).

Every one of these queries filters with `{ lte: asOf }`/`{ createdAt: { lte: asOf } }` — this `asOf` cutoff is what makes the **6-month Trust Score trend chart** possible: `trustTrend(computeFn, months = 6)` calls `landlordTrustComponents(id, monthEnd(monthsAgo))` once per month, so each historical point is computed "as if" only data up to that month-end existed, using the exact same weighted-average function as the live score.

**Income / occupancy / vacancy:**
- Occupancy: `occupied = Active listings with at least one "accepted" application`; `rate = round(occupied/totalActive*100)`.
- Vacancy: for each listing, find its *first* accepted-or-completed application by `createdAt`, compute `(firstTenanted.createdAt - listing.postedOn) / 86_400_000` days; average across listings that have one (`avgDays`), plus `sampleSize`.
- Income/net-yield trend: buckets `Payment` rows (status `"paid"`) and `ImprovementCost` rows (status `"approved"`, `loggedByRole: "landlord"`) into 6 calendar-month buckets via `monthBucketIndex(date, 6)`, then `netYield = income - improvementSpend` per month. A code comment explains a subtlety worth knowing: a tenant-fronted improvement cost that gets deducted from their deposit at move-out is *already* netted into `MoveOut.netRefund`, so it's deliberately excluded here (`loggedByRole: "landlord"` only) to avoid double-counting.

**Auto-generated insight sentences** — two kinds:
1. **Cross-platform correlations** (`getPlatformInsights()`), computed from *every* tenancy on the platform, not just this landlord's — and only emitted once both sides of the correlation have real samples. Example (maintenance SLA vs. review rating):
   ```js
   const diffPct = avgOver > 0 ? Math.round(((avgWithin - avgOver) / avgOver) * 100) : null;
   insights.push({ text: `Tenancies where maintenance requests were resolved within the ${MAINTENANCE_SLA_HOURS}h SLA average ${avgWithin.toFixed(1)}★ from tenants, vs ${avgOver.toFixed(1)}★ when resolution took longer${diffPct != null ? ` (${diffPct >= 0 ? "+" : ""}${diffPct}%)` : ""}.` });
   ```
   And a second one comparing days-to-completion for tenants with Trust Score ≥70 vs below.
2. **Personal insights** appended in `getLandlordAnalytics`/`getTenantAnalytics` directly, e.g. occupancy vs. `platformAverageOccupancy()` (the % of all Active listings platform-wide with an accepted application), maintenance resolution stats, and improvement-spend as a % of income. For tenants, `paymentCompletionPercentile(profileId, myRate)` ranks the tenant's own payment completion rate against every other tenant's rate (`% of other tenants strictly below mine`), producing sentences like "top X% of tenants."

**Frontend ↔ Backend connection:** `src/components/analytics-dashboard.tsx` exports two components. `LandlordAnalyticsSection` calls `apiFetch("/api/analytics/landlord")` → `landlordAnalytics` → `getLandlordAnalytics`, receiving the full `LandlordAnalytics` shape (`occupancy`, `income`, `improvementSpend`, `netYield`, `vacancy`, `maintenance`, `deposits`, `trust: { score, breakdown, trend }`, `insights: string[]`) and renders it with Recharts (`BarChart` for income/net-yield trend, `LineChart` for the 6-point trust trend) plus a plain `<ul>` of the insight strings. `TenantAnalyticsSection` calls `apiFetch("/api/analytics/tenant")` → `tenantAnalytics` → `getTenantAnalytics`, rendering the smaller `TenantAnalytics` shape. Both are embedded read-only, one-shot on mount (`useEffect` + `setLoading(false)` in `finally`) — no interactivity triggers a re-fetch.

---

## 4. Landlord Verification & Property Document Management

**Files:**
- `backend/controllers/admin.controller.js` (verification review endpoints)
- `backend/controllers/landlord.controller.js`
- `backend/services/verification-progress.js`
- `src/app/auth/page.tsx` (landlord signup fields)
- `src/app/landlord/page.tsx` (Trust & Documents tab)
- `src/components/trust.tsx` (`VerificationProgressBar`)

**How it works:**

Landlord signup happens through the generic `/api/auth/register` endpoint (not shown in your file list, but `auth/page.tsx` is the client side of it). When `accountType === "landlord"`, the form hard-requires 6 fields client-side before it will even submit:

```js
if (isLandlord && (!nidNumber || !phone || !propertyAddress || !nidPhoto || !ownershipProof || !selfiePhoto)) {
  throw new Error("Landlord accounts need NID number, phone, property address, both document photos, and a selfie with your NID for admin verification.");
}
```

The three photos are converted to base64 data URLs client-side (`fileToBase64`) and sent as strings in the JSON payload (`nidPhoto`, `ownershipProof`, `selfiePhoto`), capped at `MAX_PHOTO_BYTES = 1_500_000` (~1.5MB) each before encoding.

Admin review is two parallel endpoints in `admin.controller.js` — one for landlords, one for tenants, structurally identical. `reviewLandlordVerification` (`PATCH /api/admin/verifications/:verificationId`) validates `{ status: "verified" | "rejected", reviewNote? }`, updates the `LandlordVerification` row with `reviewedAt: new Date()`, and — this is the important side effect — **auto-promotes any of that landlord's Draft listings to Active on approval**:

```js
if (parsed.data.status === "verified") {
  await prisma.listing.updateMany({
    where: { landlordId: existing.profile.userId, status: "Draft" },
    data: { status: "Active" },
  });
}
```

The comment explains why: without this, a newly-verified landlord's pre-existing draft listings would stay hidden forever until they manually re-opened and re-saved each one, which contradicts what "you're now verified" implies. After that, it fires an email (`verificationApprovedEmail`/`verificationRejectedEmail` from `gmail.js`) to the landlord.

`landlord.controller.js` handles the landlord's own side. `getLandlordVerification` (`GET /api/landlord/verification`) returns just the status/note/photo URLs for the current landlord to check their own progress. Document management (utility bills, sub-let agreements) is gated **only to already-verified landlords** — this is a distinct check from account-type:

```js
if (profile.landlordVerification?.status !== "verified") {
  return res.status(403).json({ error: "Only verified landlords can upload documents for tenant inspection." });
}
```

This is deliberate: NID/ownership docs are for admin review only and never shown publicly; utility bills/sub-let agreements are shown *publicly* on the listing page, so only a landlord who has already cleared identity verification can add them.

`verification-progress.js` is pure, stateless UI-support logic — no DB access — that turns a `LandlordVerification | null` row into a step checklist:

```js
export function landlordVerificationProgress(v) {
  if (!v) return { percent: 0, status: "not_started", steps: [/* all false */] };
  const steps = [
    { label: "NID submitted", done: !!v.nidPhotoUrl },
    { label: "Ownership proof submitted", done: !!v.ownershipProofUrl },
    { label: "Selfie with NID submitted", done: !!v.selfiePhotoUrl },
    { label: "Admin review complete", done: v.status !== "pending" },
  ];
  const percent = Math.round((steps.filter((s) => s.done).length / steps.length) * 100);
  return { percent, status: v.status, steps };
}
```

Note "Admin review complete" is `true` for *both* `verified` and `rejected` — it tracks whether review happened, not whether it succeeded; the overall `status` field (used for badge color) is what actually distinguishes success from failure. There's a near-identical `tenantVerificationProgress` with only 2 steps (NID + review) since tenants don't submit ownership proof or a selfie.

**Frontend ↔ Backend connection:** On the landlord desk (`src/app/landlord/page.tsx`), the "Trust & Documents" tab loads three things on mount when `status === "authenticated"`: `apiFetch("/api/landlord/verification")` → `getLandlordVerification`, whose `{ status, reviewNote, nidPhotoUrl, ownershipProofUrl, selfiePhotoUrl }` response is fed straight into `landlordVerificationProgress(verificationDocs)` and rendered by `<VerificationProgressBar progress={...} />` from `trust.tsx`; `apiFetch("/api/landlord/trust-signals")` → `getLandlordTrustSignalsHandler`; and `loadDocuments()` → `apiFetch("/api/landlord/documents")` → `listLandlordDocuments`. Uploading a document reads the file as base64 (`fileToBase64Doc`) and does `POST /api/landlord/documents` with `{ type, label, fileUrl }` → `createLandlordDocument`, which will 403 if the landlord isn't verified yet — the frontend actually gates the whole upload UI block behind `verificationStatus === "verified"` so a non-verified landlord never sees the form that would 403. Admin's review actions (`reviewLandlordVerification`/`reviewTenantVerification`) live on a separate admin page not in this file list, but the shape they PATCH is `{ status, reviewNote }` against `/api/admin/verifications/:id` or `/api/admin/tenant-verifications/:id`.

---

## 5. Personalized Listing Match Score

**Files:**
- `backend/controllers/match.controller.js`
- `backend/services/match.js` (`geocodeAddress`, `explainMatch`)
- `backend/services/match-shared.js` (`matchScore`, `haversineKm`)
- `src/app/matches/page.tsx`
- `src/lib/match.ts` (client-side duplicate of the scoring algorithm)

**How it works:**

This feature has three layers: a preference CRUD endpoint, a pure scoring function duplicated client- and server-side, and an optional AI explanation endpoint.

**Saving preferences.** `putMatchPreference` (`PUT /api/match/preference`) validates the form with Zod, then **geocodes the tenant's typed commute-anchor text** via `geocodeAddress()` (Nominatim/OpenStreetMap, no API key) before saving — if geocoding fails, it 422s rather than saving bad coordinates:

```js
const geocoded = await geocodeAddress(parsed.data.commuteAnchorLabel);
if (!geocoded) {
  return res.status(422).json({ error: "Couldn't locate that commute anchor — try a more specific area or landmark name." });
}
```

`geocodeAddress` appends `, Dhaka, Bangladesh` to every query and sets a required custom `User-Agent` header — the code comments explain this is Nominatim's usage-policy requirement, and that it's deliberately called only once per preference save (not per-listing, not per-search) to stay within that policy. The upsert (`prisma.listingMatchPreference.upsert`) stores `commuteAnchorLat`/`Lng` alongside the raw label so the score never needs to re-geocode.

**The scoring math** (`matchScore(pref, listing)` — identical in `backend/services/match-shared.js` and `src/lib/match.ts`). Three weighted components summing to 100:

1. **Budget fit (weight 40)** — full credit if under ceiling, linear falloff to 0 if over:
   ```js
   const budgetFit = listing.rent <= pref.budgetCeiling
     ? 1
     : Math.max(0, 1 - (listing.rent - pref.budgetCeiling) / pref.budgetCeiling);
   ```
   E.g. a ceiling of ৳10,000 and rent of ৳12,000 → `1 - 2000/10000 = 0.8` → 32/40 points. Rent at double the ceiling or more floors at 0.

2. **Commute distance (weight 35)** — `haversineKm` (great-circle distance formula) between the tenant's commute anchor and the listing's lat/lng, linearly scaled against a hardcoded `MAX_COMMUTE_KM = 15`:
   ```js
   const commuteFit = Math.max(0, 1 - commuteKm / MAX_COMMUTE_KM);
   ```
   0 km → full 35 points; 15+ km → 0 points; linear in between (e.g. 7.5 km → 0.5 → 17.5 points).

3. **Room type match (weight 25)** — binary-ish: exact match = 1 (25 points), any mismatch = a flat `0.2` (5 points) rather than 0 — so room-type mismatch never fully zeroes a listing on its own, unlike a deal-breaker.

```js
const total = Math.round(parts.reduce((s, p) => s + p.weight * p.value, 0));
```

**Deal-breaker hard-zero logic** (`findDealBreaker`) runs *before* any weighted scoring and can override everything. It scans `listing.description + listing.houseRules.join(" ")` (lowercased) for hardcoded keyword lists per trait:

```js
const DEAL_BREAKER_KEYWORDS = {
  hasPets: ["no pet", "pets not allowed", "no animals"],
  smokes: ["no smoking", "non-smoking", "smoking not allowed", "smoke-free"],
  frequentVisitors: ["no visitors", "no guests", "visitors not allowed", "guests not allowed"],
};
```

If the tenant's preference says e.g. `hasPets: true` AND the listing text contains any of the pet-related keywords, that's a hard block — regardless of how good budget/commute/room-type fit is, `matchScore` forces `total: 0`:

```js
return {
  total: blockReason ? 0 : total,
  parts, hardBlocked: !!blockReason, blockReason, commuteKm,
};
```

This is purely keyword text matching, not structured data — a listing that says "sorry, no pets allowed here" matches, but one that phrases it unusually (e.g. "pet-free household") would not trigger the block, since that exact phrase isn't in the keyword list.

**The Gemini explanation call** is a *separate, on-demand* step, not part of scoring. `explainListingMatch` (`POST /api/match/explain`) recomputes `matchScore` server-side (never trusts a client-sent score) then calls `explainMatch(pref, listing, result)` in `match.js`, which builds a fact-only prompt (explicitly instructing the model not to invent anything) and calls `gemini-flash-lite-latest`. If `GEMINI_API_KEY` is unset, the call throws, or the response is empty, it falls back to a deterministic sentence built from the score parts (`fallbackExplanation`) — so the UI never has "no explanation," only "AI-quality" vs "templated" explanation, communicated to the frontend via `source: "ai" | "fallback"`. A code comment explains why this is per-listing-on-click rather than eager: the score itself is free/client-computable, but Gemini is a real network call that shouldn't fire once per listing on every search-page render.

**Why the duplicate exists** (`src/lib/match.ts` vs `backend/services/match-shared.js`): they are line-for-line identical algorithms (TS types added client-side). The frontend needs `matchScore` to compute match % for *every* listing on the search/matches page instantly and re-sort as filters change, without a network round-trip per listing or per re-render — so the pure math is duplicated client-side. The backend's copy (`match-shared.js`) is authoritative for anything that must be trusted server-side: `compareListings` (saved-listings comparison) and `explainListingMatch` both compute the score server-side from the DB's own preference/listing rows rather than accepting a client-sent score, precisely so a tenant can't spoof their own match percentage.

**Frontend ↔ Backend connection:** `src/app/matches/page.tsx` loads the saved preference via `apiFetch("/api/match/preference")` (GET → `getMatchPreference`), lets the tenant edit it in a form, and saves via `apiFetch("/api/match/preference", { method: "PUT", body: {...} })` → `putMatchPreference` (server geocodes and stores it, returns the full row including resolved lat/lng). It also does `apiFetch("/api/listings")` to get every active listing, then — entirely client-side — runs `matchScore(pref, listing)` from `src/lib/match.ts` over the whole array and sorts descending by `.total`:
```js
const ranked = useMemo(() => {
  if (!pref) return [];
  return listings.map((listing) => ({ listing, result: matchScore(pref, listing) })).sort((a, b) => b.result.total - a.result.total);
}, [listings, pref]);
```
Clicking "Why this matches →" triggers `apiFetch("/api/match/explain", { method: "POST", body: { listingId } })` → `explainListingMatch`, returning `{ total, hardBlocked, explanation, source }` which is cached in `explanations[listingId]` state so re-clicking doesn't refire the network call. `src/app/page.tsx` (home search) also imports `matchScore` from `src/lib/match.ts` directly (not via the matches page) to compute a per-listing "X% match" badge and to support the "Best match for you" sort option, using the same locally-loaded preference (`apiFetch("/api/match/preference")`) fetched once for a signed-in tenant.

---

## 6. Property & Tenant History Panels

**Files:**
- `backend/services/property-history.js`
- `backend/services/tenant-history.js`
- `src/app/listings/[listingId]/listing-detail.tsx` (History section)
- `src/app/profile/page.tsx` ("Your history" section)

**How it works:**

Both services are pure aggregation queries — no scoring, no weighting — and both are explicitly anonymized: they return counts/rates only, never per-tenancy detail or names.

`getPropertyHistory(listingId)` (property side, shown to *prospective tenants* browsing a listing) runs three parallel Prisma queries:
- `pastTenancyCount`: count of that listing's `Application`s with status `accepted` or `completed`.
- `disputes`: all `Dispute` rows tied to applications on this listing, to compute `resolvedDisputeCount` (status `"resolved"`) vs `totalDisputeCount`.
- `avgTenancyMonths`: derived from signed `AgreementDraft`s. This one has a genuinely tricky join, explained in the code's own comment — `AgreementDraft` has no `listingId` column, so the link only exists inside its `reference` string field, formatted as `${listingId}/${durationMonths}M`:
  ```js
  prisma.agreementDraft.findMany({
    where: {
      reference: { startsWith: `${listingId}/` },
      tenantSignature: { not: null },
      landlordSignature: { not: null },
    },
    select: { termsJson: true },
  })
  ```
  Only fully-signed drafts count (both signatures present), and the duration is pulled out of the JSON `termsJson.durationMonths` field, averaged and rounded to 1 decimal.

`getTenantHistorySummaries(profileIds)` (tenant side, batch — used by the landlord's applicant list) is more involved because it needs per-profile aggregation across three unrelated tables in one pass. It seeds a `Map` with an empty-history object per id, then folds in three query results:
```js
for (const a of applications) { const h = map.get(a.profileId); if (h) h.confirmedTenancyCount += 1; }
```
Payments are grouped by profile into `{paid, total}` counters first, then converted to a percentage per profile. Disputes are the trickiest: a dispute "involves" a tenant whether they *filed* it or it was filed *against their tenancy*, so it's counted for whichever of those profile ids is in the requested batch:
```js
const relevantIds = new Set([d.filedByProfileId, d.application.profileId].filter((id) => ids.includes(id)));
for (const profileId of relevantIds) { const h = map.get(profileId); if (!h) continue; h.disputeCount += 1; if (d.status === "resolved") h.resolvedDisputeCount += 1; }
```
Note the code comment on "on-time payment rate": there's no due-date column anywhere in the schema, so `onTimePaymentRate` is literally just `status === "paid"` count over total — deliberately reusing the *exact* same ratio the Trust Score's `payment` component uses, so this panel can never show a number that contradicts the Trust Score computed from the same underlying data.

**Frontend ↔ Backend connection:** Property history reaches the frontend bundled inside `getListingDetail`'s response (`GET /api/listings/:listingId/detail`, Feature 1) — `listing-detail.tsx` receives `history: PropertyHistory` as a prop (no separate fetch) and renders it directly as 4 `Signal` stat tiles under an "aggregate record... anonymized" heading:
```tsx
<Signal label="Past tenancies" value={`${history.pastTenancyCount}`} />
<Signal label="Avg. tenancy length" value={history.avgTenancyMonths != null ? `${history.avgTenancyMonths} mo` : "No data yet"} />
<Signal label="Disputes resolved" value={`${history.resolvedDisputeCount}`} />
<Signal label="Disputes filed" value={`${history.totalDisputeCount}`} />
```
Tenant history reaches `src/app/profile/page.tsx` bundled inside the aggregate `GET /api/profile` response (not one of the files you were given, but it's the caller) as `data.history`, rendered in the "Verification & History" tab's "Your history" section using the same `Signal` component — confirmed tenancies, on-time payment rate, disputes resolved, disputes on record. The same `getTenantHistorySummaries` function also backs the landlord-facing applicant list in `src/app/landlord/page.tsx` (Feature 2), via each `RealApplication.history` field returned from `listApplicationsForListing`.

---

## 7. Saved Listings / Shortlist

**Files:**
- `backend/controllers/listing.controller.js` (`toggleSaveListing`, `getSaveStatus`, `compareListings`)
- `backend/services/trust-signals.js` (`getTrustScoresForLandlords` — actually defined in `backend/services/analytics.js`, re-used by `compareListings`)
- `src/components/saved-listings-compare.tsx`
- `src/components/export-settings.tsx` (CSV/PDF export)

**Correction on file locations:** `getTrustScoresForLandlords` is actually defined in `backend/services/analytics.js` (not `trust-signals.js` — that file only has `getTenantTrustSignals`/`getLandlordTrustSignals`, the response-time/completed-rentals signals, a different concept from the weighted Trust Score). `listing.controller.js` imports it from `../services/analytics.js`. Also, **`saved-listings-compare.tsx` does not use `export-settings.tsx` at all** — grepping the codebase shows `ExportSettings`/CSV/PDF export is wired up only in `src/app/agreement/page.tsx` and `src/app/roommates/page.tsx`, not the saved-listings compare table. The compare table's own "remove" action is the only mutation it performs.

**How it works:**

Saving/unsaving is a simple toggle. `toggleSaveListing` (`POST /api/listings/save`, auth required) looks up whether a `SavedListing` row already exists for `(profileId, listingId)`; if so it deletes it (returns `{ saved: false }`), otherwise creates it (returns `{ saved: true }`). Two concurrency details worth knowing: it uses `deleteMany` instead of `delete` on the found id, so a race where another request already deleted the same row doesn't throw `P2025` (record not found) — it just matches zero rows silently; and the `create` is wrapped in try/catch for the `P2002` unique-constraint case (two near-simultaneous save clicks), swallowing that specific error since the end state is correct either way:
```js
if (existing) {
  await prisma.savedListing.deleteMany({ where: { id: existing.id } });
  return res.json({ saved: false });
}
try {
  await prisma.savedListing.create({ data: { profileId: user.profile.id, listingId: parsed.data.listingId } });
} catch (err) {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
}
return res.json({ saved: true });
```

`getSaveStatus` (`GET /api/listings/save?listingId=`) is deliberately **not** behind `requireAuth` middleware — the code comment explains why: it needs to answer "not saved" for a logged-out visitor rather than 401ing, so it manually/optimistically decodes the JWT with `getOptionalUserId(req)` (returns `null` on any missing/invalid token instead of throwing) and just returns `{ saved: false }` if there's no valid user, profile, or matching row.

`compareListings` (`GET /api/listings/compare`, auth required) is the real feature logic — it builds the whole comparison table server-side in one call. Steps:
1. Load the caller's `Profile` with their `matchPreference`.
2. Optionally geocode a `landmark` query param (again via Nominatim, and again the comment stresses this fires once per request, not once per saved listing — same usage-policy discipline as Feature 5).
3. Load all `SavedListing`s for the profile with their `listing` relation included.
4. Batch-fetch Trust Scores for every distinct landlord among the saved listings via `getTrustScoresForLandlords(saved.map(s => s.listing.landlordId))`.
5. Build one row per saved listing:
```js
const rows = saved.map((s) => {
  const listing = s.listing;
  return {
    savedId: s.id, listingId: listing.id, title: listing.title, area: listing.area, city: listing.city,
    rent: listing.rent, roomType: listing.roomType,
    landlordTrustScore: trustScores.get(listing.landlordId) ?? null,
    matchPercent: pref ? matchScore(pref, listing).total : null,
    distanceKm: landmark ? Math.round(haversineKm(landmark.lat, landmark.lng, listing.latitude, listing.longitude) * 10) / 10 : null,
  };
});
```
Note `matchPercent` reuses the exact same `matchScore` from `match-shared.js` (Feature 5) — computed server-side here, not the client copy, because this endpoint already has the tenant's saved preference and listing rows in hand and there's no reason to duplicate that logic. `getTrustScoresForLandlords` (in `analytics.js`) is a lightweight variant of the analytics logic: for each distinct landlord id, it calls `landlordTrustComponents(id, now)` then `weightedScore(...)` — literally the same weighted-average function used for the full analytics dashboard (Feature 3), but returning just a `Map<landlordId, number|null>` rather than the full analytics payload, since the compare table only needs one number per row.

**Frontend ↔ Backend connection:** `src/components/saved-listings-compare.tsx` calls `apiFetch("/api/listings/compare")` on mount (no `landmark` param) → `compareListings`, receiving `{ landmark: null, rows: CompareRow[] }` and rendering one table row per saved listing (rent, `landlordTrustScore`, `matchPercent`, and conditionally a distance column). Submitting the landmark search box re-calls `apiFetch(\`/api/listings/compare?landmark=${encodeURIComponent(text)}\`)`, which re-triggers the Nominatim geocode server-side and adds the `distanceKm` column once `activeLandmark` is set from the response. The "remove" button per row calls `apiFetch("/api/listings/save", { method: "POST", body: { listingId } })` → `toggleSaveListing` (which will unsave it, since it's currently saved), then reloads the compare table. This component is rendered inside `src/app/profile/page.tsx`'s "Saved & Roommates" tab. `src/components/export-settings.tsx` is a self-contained, presentation-only component exposing `downloadCsv`/`downloadSimplePdf` helper functions (client-side only — builds a CSV string or a `jsPDF` document entirely in the browser, no backend call at all) and is currently consumed by the agreement and roommates pages, not by `saved-listings-compare.tsx` — if an exam task asks you to "add export to the saved listings table," you'd be wiring `ExportSettings` + `downloadCsv`/`downloadSimplePdf` into `saved-listings-compare.tsx` for the first time, following the same pattern already used in `src/app/roommates/page.tsx`.
