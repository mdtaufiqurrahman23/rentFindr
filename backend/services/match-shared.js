// Personalized Listing Match Score — tenant-to-listing. Ported from
// src/lib/match.ts (plain, non-".server" pure math — no Prisma, no external
// calls), stripped of TS types. Kept as its own module (not merged into
// services/match.js, which is the ported match.server.ts) so both the
// listing controller's compare endpoint and any future caller can import
// just the pure scoring math without pulling in Gemini/Nominatim.
//
// MatchPreference = { budgetCeiling, commuteAnchorLat, commuteAnchorLng, roomType, hasPets, smokes, frequentVisitors }
// MatchableListing = { rent, roomType, latitude, longitude, description, houseRules }
// MatchResult = { total, parts: [{ label, weight, value, detail }], hardBlocked, blockReason, commuteKm }

/** Great-circle distance in km. */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const DEAL_BREAKER_KEYWORDS = {
  hasPets: ["no pet", "pets not allowed", "no animals"],
  smokes: ["no smoking", "non-smoking", "smoking not allowed", "smoke-free"],
  frequentVisitors: ["no visitors", "no guests", "visitors not allowed", "guests not allowed"],
};

function findDealBreaker(pref, listing) {
  const text = `${listing.description ?? ""} ${listing.houseRules.join(" ")}`.toLowerCase();
  const traits = [
    {
      key: "hasPets",
      has: pref.hasPets,
      label: "you have pets, but this listing doesn't allow pets",
    },
    { key: "smokes", has: pref.smokes, label: "you smoke, but this listing is non-smoking" },
    {
      key: "frequentVisitors",
      has: pref.frequentVisitors,
      label: "you have frequent visitors, but this listing doesn't allow visitors",
    },
  ];
  for (const t of traits) {
    if (!t.has) continue;
    if (DEAL_BREAKER_KEYWORDS[t.key].some((kw) => text.includes(kw))) {
      return t.label;
    }
  }
  return null;
}

export function matchScore(pref, listing) {
  const blockReason = findDealBreaker(pref, listing);

  const budgetFit =
    listing.rent <= pref.budgetCeiling
      ? 1
      : Math.max(0, 1 - (listing.rent - pref.budgetCeiling) / pref.budgetCeiling);

  const commuteKm = haversineKm(
    pref.commuteAnchorLat,
    pref.commuteAnchorLng,
    listing.latitude,
    listing.longitude,
  );
  const MAX_COMMUTE_KM = 15;
  const commuteFit = Math.max(0, 1 - commuteKm / MAX_COMMUTE_KM);

  const roomTypeFit = listing.roomType === pref.roomType ? 1 : 0.2;

  const parts = [
    {
      label: "Budget fit",
      weight: 40,
      value: budgetFit,
      detail:
        listing.rent <= pref.budgetCeiling
          ? `৳${listing.rent.toLocaleString("en-BD")} is within your ৳${pref.budgetCeiling.toLocaleString("en-BD")} ceiling`
          : `৳${listing.rent.toLocaleString("en-BD")} is over your ৳${pref.budgetCeiling.toLocaleString("en-BD")} ceiling`,
    },
    {
      label: "Commute distance",
      weight: 35,
      value: commuteFit,
      detail: `${commuteKm.toFixed(1)} km from your commute anchor`,
    },
    {
      label: "Room type match",
      weight: 25,
      value: roomTypeFit,
      detail:
        listing.roomType === pref.roomType
          ? `${listing.roomType} matches what you're looking for`
          : `${listing.roomType}, not your preferred ${pref.roomType}`,
    },
  ];

  const total = Math.round(parts.reduce((s, p) => s + p.weight * p.value, 0));

  return {
    total: blockReason ? 0 : total,
    parts,
    hardBlocked: !!blockReason,
    blockReason,
    commuteKm,
  };
}
