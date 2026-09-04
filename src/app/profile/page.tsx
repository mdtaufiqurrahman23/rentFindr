"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SignOutButton } from "./sign-out-button";
import { DeleteButton } from "./delete-button";
import { VerifyIdentity } from "./verify-identity";
import { ReviewPanel } from "@/components/review-panel";
import { PayRentForm } from "./pay-rent-form";
import { MoveOutPanel } from "@/components/move-out-panel";
import { ImprovementCostLog } from "@/components/improvement-cost-log";
import { ActivityTimeline } from "@/components/activity-timeline";
import { TenantAnalyticsSection } from "@/components/analytics-dashboard";
import { Signal, VerificationProgressBar } from "@/components/trust";
import { formatLastActive } from "@/lib/trust-signals";
import { tenantVerificationProgress } from "@/lib/verification-progress";
import { SavedListingsCompare } from "@/components/saved-listings-compare";
import { LeaseTimelineBar } from "@/components/lease-timeline-bar";
import type { LeaseTimeline } from "@/lib/lease-timeline";
import type { ActivityEventItem } from "@/components/activity-timeline";

type RoommateSessionProfileData = {
  budget?: number;
  sleep?: string;
  smoking?: string;
  smokingNonNegotiable?: boolean;
  study?: string;
  visitors?: string;
};

type ApplicationItem = {
  id: string;
  status: string;
  note?: string | null;
  createdAt: string;
  listingId: string;
  listing: { title: string; area: string; rent: number };
};

type RoommateSessionItem = {
  id: string;
  label: string;
  createdAt: string;
  profileData: RoommateSessionProfileData;
  results: unknown[];
};

type AgreementDraftItem = {
  id: string;
  reference: string;
  source: string;
  clausesJson: unknown[];
  createdAt: string;
};

type ReviewItem = {
  id: string;
  rating: number;
  comment?: string | null;
  createdAt: string;
  application: { listing: { title: string } };
};

type TenantLeaseTimelineItem = LeaseTimeline & {
  applicationId: string;
  listingId: string;
  listingTitle: string;
};

const paymentBannerCopy: Record<string, string> = {
  success: "Payment received — thanks! A receipt has been emailed to you.",
  failed: "That payment failed. No charge was made — you can try again from your application.",
  cancelled: "Payment cancelled. No charge was made.",
};

// The full aggregate shape returned by GET /api/profile — mirrors what the
// server component used to fetch directly from Prisma. Left loosely typed
// (fields as returned by the API) rather than re-declaring every Prisma
// model shape client-side.
type ProfileData = {
  user: { id: string; email: string; role: string };
  profile: {
    displayName: string | null;
    accountType: string | null;
    tenantVerification: {
      status: "pending" | "verified" | "rejected";
      reviewNote?: string | null;
      nidPhotoUrl: string | null;
    } | null;
  };
  savedListingsCount: number;
  applications: ApplicationItem[];
  roommateSessions: RoommateSessionItem[];
  agreementDrafts: AgreementDraftItem[];
  reviewsReceived: ReviewItem[];
  history: {
    confirmedTenancyCount: number;
    onTimePaymentRate: number | null;
    resolvedDisputeCount: number;
    disputeCount: number;
  };
  leaseTimelines: TenantLeaseTimelineItem[];
  trustSignals: {
    completedRentals: number;
    avgResponseHours: number | null;
    lastActiveAt: string | null;
  } | null;
  activityByListing: Record<string, ActivityEventItem[]>;
};

// Bold, unmissable pill buttons for the tab bar — deliberately louder than
// the base ui/tabs.tsx default (small muted bar, subtle active state), which
// tested as too easy to miss. Matches the accent-fill CTA language already
// used for the sign-in/mode toggle buttons on src/app/auth/page.tsx.
const tabsListCls = "flex w-full flex-wrap gap-2 h-auto bg-transparent p-0 justify-start";
const tabTriggerCls =
  "rounded-full border px-5 py-2.5 font-mono text-xs uppercase tracking-widest transition-colors " +
  "data-[state=active]:border-accent data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-sm " +
  "data-[state=inactive]:border-border data-[state=inactive]:hover:bg-secondary";

export default function ProfilePage() {
  return (
    <Suspense fallback={null}>
      <ProfilePageInner />
    </Suspense>
  );
}

function ProfilePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status } = useSession();
  const payment = searchParams.get("payment");
  const paymentBanner = payment ? (paymentBannerCopy[payment] ?? null) : null;

  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch("/api/profile");
    if (res.status === 401) {
      router.push("/auth");
      return;
    }
    if (!res.ok) {
      setError("Could not load your profile.");
      return;
    }
    setData(await res.json());
  }, [router]);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/auth");
      return;
    }
    if (status === "authenticated") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void load();
    }
  }, [status, load, router]);

  if (status === "loading" || (status === "authenticated" && !data && !error)) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-24 text-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-24 text-center text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const {
    profile,
    applications,
    roommateSessions,
    agreementDrafts,
    reviewsReceived,
    history,
    leaseTimelines,
    trustSignals,
    activityByListing,
    savedListingsCount,
  } = data;
  const isTenant = profile.accountType === "tenant";

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-border pb-8">
        <div>
          <p className="eyebrow">Profile</p>
          <h1 className="mt-3 font-display text-4xl font-bold uppercase tracking-tight sm:text-5xl">
            {profile.displayName || data.user.email}
          </h1>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {data.user.email} · {String(data.user.role).toLowerCase()}
            {profile.accountType && ` · ${profile.accountType}`}
          </p>
        </div>
        <SignOutButton />
      </header>

      {paymentBanner && (
        <p
          className={`mt-6 border-l-2 pl-3 text-sm ${payment === "success" ? "border-primary text-primary" : "border-destructive text-destructive"}`}
        >
          {paymentBanner}
        </p>
      )}

      <Tabs defaultValue="overview" className="mt-10">
        <TabsList className={tabsListCls}>
          <TabsTrigger value="overview" className={tabTriggerCls}>
            Overview
          </TabsTrigger>
          {isTenant && (
            <TabsTrigger value="verification" className={tabTriggerCls}>
              Verification &amp; History
            </TabsTrigger>
          )}
          <TabsTrigger value="applications" className={tabTriggerCls}>
            Applications &amp; Lease · {applications.length}
          </TabsTrigger>
          <TabsTrigger value="saved" className={tabTriggerCls}>
            Saved &amp; Roommates
          </TabsTrigger>
          <TabsTrigger value="agreements" className={tabTriggerCls}>
            Agreements &amp; Reviews
          </TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="mt-8">
          <section>
            <h2 className="text-2xl mb-6">Overview</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                ["Email", data.user.email],
                ["Account type", profile.accountType || "—"],
                ["Saved listings", savedListingsCount],
                ["Applications", applications.length],
              ].map(([label, value]) => (
                <div
                  key={label as string}
                  className="rounded-2xl border border-border bg-[var(--card)] p-6"
                >
                  <p className="eyebrow">{label}</p>
                  <p className="mt-2 font-mono text-sm">{value}</p>
                </div>
              ))}
            </div>
          </section>

          {isTenant && (
            <section className="mt-12">
              <h2 className="text-2xl">Your insights</h2>
              <TenantAnalyticsSection />
            </section>
          )}
        </TabsContent>

        {/* Verification & History (tenants only) */}
        {isTenant && (
          <TabsContent value="verification" className="mt-8">
            <section>
              <h2 className="text-2xl mb-6">Identity verification</h2>
              <VerifyIdentity
                initialStatus={profile.tenantVerification?.status ?? null}
                initialNote={profile.tenantVerification?.reviewNote ?? null}
              />
              <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
                <div className="rounded-2xl border border-border bg-[var(--card)] p-6">
                  <VerificationProgressBar
                    progress={tenantVerificationProgress(profile.tenantVerification ?? null)}
                  />
                </div>
                {trustSignals && (
                  <div className="grid grid-cols-2 gap-5 rounded-2xl border border-border bg-[var(--card)] p-6 sm:grid-cols-3">
                    <Signal label="Completed rentals" value={`${trustSignals.completedRentals}`} />
                    <Signal
                      label="Avg. response time"
                      value={
                        trustSignals.avgResponseHours != null
                          ? `${trustSignals.avgResponseHours}h`
                          : "No data yet"
                      }
                    />
                    <Signal label="Activity" value={formatLastActive(trustSignals.lastActiveAt)} />
                  </div>
                )}
              </div>
            </section>

            <section className="mt-12">
              <h2 className="text-2xl mb-1">Your history</h2>
              <p className="mb-6 text-xs text-muted-foreground">
                A transparent, browsable version of what your Trust Score already uses internally.
              </p>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Signal label="Confirmed tenancies" value={`${history.confirmedTenancyCount}`} />
                <Signal
                  label="On-time payment rate"
                  value={
                    history.onTimePaymentRate != null
                      ? `${history.onTimePaymentRate}%`
                      : "No data yet"
                  }
                />
                <Signal label="Disputes resolved" value={`${history.resolvedDisputeCount}`} />
                <Signal label="Disputes on record" value={`${history.disputeCount}`} />
              </div>
            </section>
          </TabsContent>
        )}

        {/* Applications & Lease */}
        <TabsContent value="applications" className="mt-8">
          {isTenant && leaseTimelines.length > 0 && (
            <section>
              <h2 className="text-2xl mb-1">Lease timeline</h2>
              <p className="mb-6 text-xs text-muted-foreground">
                Move-in, elapsed tenancy, and the renewal-decision window — the same dates the
                expiry reminder emails use.
              </p>
              <div className="space-y-6">
                {leaseTimelines.map((t) => (
                  <div
                    key={t.applicationId}
                    className="rounded-2xl border border-border bg-[var(--card)] p-6"
                  >
                    <p className="mb-3 text-sm font-medium">{t.listingTitle}</p>
                    <LeaseTimelineBar timeline={t} />
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className={isTenant && leaseTimelines.length > 0 ? "mt-12" : ""}>
            <h2 className="text-2xl mb-6">Applications ({applications.length})</h2>
            {applications.length === 0 ? (
              <Empty message="No applications yet." cta="Find properties" href="/" />
            ) : (
              <div className="space-y-4">
                {applications.map((app) => (
                  <div
                    key={app.id}
                    className="rounded-2xl border border-border bg-[var(--card)] p-6"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <h3 className="font-medium">{app.listing.title}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">{app.listing.area}</p>
                        {app.note && (
                          <p className="mt-2 text-sm italic text-muted-foreground">
                            &quot;{app.note}&quot;
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                          {app.status}
                        </span>
                        <DeleteButton id={app.id} type="application" onDeleted={load} />
                      </div>
                    </div>
                    <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                      Applied {new Date(app.createdAt).toLocaleDateString()}
                    </p>
                    {app.status === "accepted" && (
                      <>
                        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
                          <Link
                            href={`/agreement?applicationId=${app.id}`}
                            className="text-sm underline underline-offset-4"
                          >
                            View agreement →
                          </Link>
                          <Link
                            href="/maintenance"
                            className="text-sm underline underline-offset-4"
                          >
                            Maintenance →
                          </Link>
                          <Link
                            href={`/messages/${app.id}`}
                            className="text-sm underline underline-offset-4"
                          >
                            Message →
                          </Link>
                          <Link href="/disputes" className="text-sm underline underline-offset-4">
                            File a dispute →
                          </Link>
                        </div>
                        <PayRentForm listingId={app.listingId} rent={app.listing.rent} />
                        <MoveOutPanel applicationId={app.id} viewerIsLandlord={false} />
                        <ImprovementCostLog applicationId={app.id} viewerIsLandlord={false} />
                        <div className="mt-5 border-t border-border pt-5">
                          <p className="eyebrow mb-4">Activity timeline</p>
                          <ActivityTimeline events={activityByListing[app.listingId] ?? []} />
                        </div>
                      </>
                    )}
                    {app.status === "completed" && (
                      <>
                        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
                          <Link
                            href={`/messages/${app.id}`}
                            className="text-sm underline underline-offset-4"
                          >
                            Message →
                          </Link>
                          <Link href="/disputes" className="text-sm underline underline-offset-4">
                            File a dispute →
                          </Link>
                        </div>
                        <ReviewPanel applicationId={app.id} viewerIsTenant={true} />
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </TabsContent>

        {/* Saved & Roommates */}
        <TabsContent value="saved" className="mt-8">
          <section>
            <h2 className="text-2xl mb-1">Saved listings ({savedListingsCount})</h2>
            <p className="mb-6 text-xs text-muted-foreground">
              Compare your shortlist side by side — rent, landlord Trust Score, Match %, and
              distance to a landmark of your choice.
            </p>
            <SavedListingsCompare />
          </section>

          <section className="mt-12">
            <h2 className="text-2xl mb-6">Matching sessions ({roommateSessions.length})</h2>
            {roommateSessions.length === 0 ? (
              <Empty
                message="No matching sessions saved yet."
                cta="Start compatibility matcher"
                href="/roommates"
              />
            ) : (
              <div className="space-y-4">
                {roommateSessions.map((s) => {
                  const pd = s.profileData as RoommateSessionProfileData;
                  const results = s.results as unknown[];
                  return (
                    <div
                      key={s.id}
                      className="rounded-2xl border border-border bg-[var(--card)] p-6"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <h3 className="font-medium">{s.label}</h3>
                          <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
                            <span>Budget: ৳{(pd?.budget || 0).toLocaleString()}</span>
                            <span>Sleep: {pd?.sleep || "—"}</span>
                            <span>
                              Smoking: {pd?.smoking || "—"}
                              {pd?.smokingNonNegotiable ? " (non-neg.)" : ""}
                            </span>
                            <span>Study: {pd?.study || "—"}</span>
                            <span>Visitors: {pd?.visitors || "—"}</span>
                            <span>{results.length} candidates scored</span>
                          </div>
                        </div>
                        <DeleteButton id={s.id} type="roommateSession" onDeleted={load} />
                      </div>
                      <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                        Saved {new Date(s.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-4">
              <Link href="/roommates" className="text-sm underline underline-offset-4">
                Run a new matching session →
              </Link>
            </div>
          </section>
        </TabsContent>

        {/* Agreements & Reviews */}
        <TabsContent value="agreements" className="mt-8">
          <section>
            <h2 className="text-2xl mb-6">Agreement drafts ({agreementDrafts.length})</h2>
            {agreementDrafts.length === 0 ? (
              <Empty
                message="No agreement drafts yet."
                cta="Go to agreement page"
                href="/agreement"
              />
            ) : (
              <div className="space-y-4">
                {agreementDrafts.map((d) => (
                  <div key={d.id} className="rounded-2xl border border-border bg-[var(--card)] p-6">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <h3 className="font-medium font-mono">{d.reference}</h3>
                        <p className="mt-1 text-sm text-muted-foreground capitalize">
                          {d.source} · {(d.clausesJson as unknown[]).length} clauses
                        </p>
                      </div>
                      <DeleteButton id={d.id} type="agreementDraft" onDeleted={load} />
                    </div>
                    <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                      Generated {new Date(d.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mt-12">
            <h2 className="text-2xl mb-6">Reviews received ({reviewsReceived.length})</h2>
            {reviewsReceived.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No reviews yet — these come from landlords once a tenancy ends.
              </p>
            ) : (
              <div className="space-y-4">
                {reviewsReceived.map((r) => (
                  <div key={r.id} className="rounded-2xl border border-border bg-[var(--card)] p-6">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm">
                          {"★".repeat(r.rating)}
                          {"☆".repeat(5 - r.rating)}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {r.application.listing.title}
                        </p>
                        {r.comment && (
                          <p className="mt-2 text-sm italic text-muted-foreground">
                            &ldquo;{r.comment}&rdquo;
                          </p>
                        )}
                      </div>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {new Date(r.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Empty({ message, cta, href }: { message: string; cta: string; href: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border p-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Link href={href} className="mt-4 inline-block text-sm underline underline-offset-4">
        {cta}
      </Link>
    </div>
  );
}
