// Backend copy of the subset of src/data/module1.ts actually used by the
// ported services (services/analytics.js, services/landlord-summary.js).
// The original src/data/module1.ts also holds a large amount of frontend
// mock/display data (listings, applicants, landlordsById, image imports,
// etc.) that has no business-logic purpose here and was deliberately not
// copied — only TRUST_WEIGHTS (analytics.js) and formatDate
// (landlord-summary.js) are needed.

export const TRUST_WEIGHTS = [
  {
    key: "payment",
    label: "Payment history",
    weight: 0.25,
    measures: "Receipt confirmation & deposit-return timeliness",
  },
  {
    key: "maintenance",
    label: "Maintenance response",
    weight: 0.2,
    measures: "Average request resolution time",
  },
  {
    key: "disputes",
    label: "Dispute outcomes",
    weight: 0.2,
    measures: "Share resolved in favour or no fault found",
  },
  {
    key: "verification",
    label: "Profile verification",
    weight: 0.15,
    measures: "NID, ownership proof and phone verified",
  },
  { key: "reviews", label: "Review rating", weight: 0.1, measures: "Average of category ratings" },
  {
    key: "agreements",
    label: "Agreement completion",
    weight: 0.1,
    measures: "Leases completed on original terms",
  },
];

export const formatDate = (iso) => {
  const d = new Date(iso);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
