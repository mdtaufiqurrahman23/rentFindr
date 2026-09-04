// Bulk demo-listing generator — separate from seed.js on purpose, so it can be
// re-run independently to top up test data without touching the curated demo
// narrative (agreements, disputes, messages, etc.) that seed.js sets up.
//
// Spreads listings across the 3 already-verified demo landlords (so they're
// "Active" and searchable immediately, no admin review needed) and many real
// Dhaka neighborhoods/room types/price points, purely so the site has enough
// volume and variety to actually exercise search, filtering, sorting, compare,
// and each landlord's own dashboard — not meant to be realistic property data.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000);

function placeholderImage(label, bg = "e5e7eb", fg = "374151") {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='300'><rect width='100%' height='100%' fill='#${bg}'/><text x='50%' y='50%' font-family='sans-serif' font-size='22' fill='#${fg}' text-anchor='middle' dominant-baseline='middle'>${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// [area, lat, lng, priceMultiplier] — multiplier nudges rent up/down per
// neighborhood so filtering by price range actually separates areas.
const AREAS = [
  ["Dhanmondi", 23.7461, 90.3742, 1.15],
  ["Gulshan 1", 23.7808, 90.4142, 1.6],
  ["Gulshan 2", 23.7925, 90.4078, 1.65],
  ["Banani", 23.7936, 90.4043, 1.5],
  ["Baridhara", 23.7989, 90.4198, 1.55],
  ["Bashundhara R/A", 23.8146, 90.4351, 1.35],
  ["Uttara Sector 3", 23.8759, 90.3795, 1.1],
  ["Uttara Sector 10", 23.8438, 90.3997, 1.05],
  ["Mirpur 1", 23.7961, 90.352, 0.75],
  ["Mirpur 10", 23.8069, 90.3687, 0.8],
  ["Mohammadpur", 23.7656, 90.3588, 0.9],
  ["Shyamoli", 23.7698, 90.3654, 0.95],
  ["Mohakhali", 23.7797, 90.4051, 1.1],
  ["Farmgate", 23.7574, 90.3899, 1.0],
  ["Kawran Bazar", 23.7508, 90.3928, 1.05],
  ["Malibagh", 23.7469, 90.4128, 0.9],
  ["Rampura", 23.758, 90.4256, 0.85],
  ["Badda", 23.7809, 90.4266, 0.9],
  ["Khilgaon", 23.7443, 90.4267, 0.85],
  ["Wari", 23.7185, 90.4181, 0.8],
  ["Lalbagh", 23.7188, 90.3888, 0.75],
  ["Jatrabari", 23.7104, 90.4335, 0.65],
  ["Lalmatia", 23.755, 90.3667, 1.1],
  ["Elephant Road", 23.7378, 90.386, 1.0],
  ["Azimpur", 23.7278, 90.3831, 0.85],
  ["Panthapath", 23.7517, 90.3877, 1.05],
  ["Tejgaon", 23.7699, 90.3963, 0.95],
  ["Kalabagan", 23.7466, 90.3838, 1.1],
  ["Segunbagicha", 23.7361, 90.4113, 0.95],
  ["Shantinagar (North)", 23.745, 90.412, 1.0],
];

const ROOM_TYPES = [
  { type: "Single room", baseRent: 8000, baseDeposit: 1.5, baseSqft: 160, sqftJitter: 60 },
  { type: "Shared mess", baseRent: 5500, baseDeposit: 1.0, baseSqft: 200, sqftJitter: 80 },
  { type: "Studio", baseRent: 13000, baseDeposit: 2.0, baseSqft: 320, sqftJitter: 60 },
  { type: "Full flat", baseRent: 22000, baseDeposit: 2.0, baseSqft: 750, sqftJitter: 300 },
];

const TITLE_TEMPLATES = {
  "Single room": [
    "Sunlit single room near {area}",
    "Quiet single room, walk to {area} market",
    "Furnished single room in {area}",
    "Single room with attached bath, {area}",
  ],
  "Shared mess": [
    "Student-friendly mess seat, {area}",
    "Shared mess room with balcony, {area}",
    "Budget mess seat near {area} bus stop",
    "Co-living mess room, {area}",
  ],
  Studio: [
    "Compact studio with kitchenette, {area}",
    "Modern studio apartment, {area}",
    "Studio flat, rooftop access, {area}",
    "Self-contained studio near {area}",
  ],
  "Full flat": [
    "3-bed family flat in {area}",
    "Spacious full flat, {area}",
    "Newly renovated flat, {area}",
    "2-bed apartment with balcony, {area}",
  ],
};

const HOUSE_RULE_SETS = [
  [],
  ["No smoking indoors"],
  ["Family tenants preferred"],
  ["No pets"],
  ["No smoking indoors", "No overnight guests without notice"],
  ["Students welcome"],
  ["Quiet hours after 10pm"],
];

function pick(arr, i) {
  return arr[i % arr.length];
}

function round(n, step) {
  return Math.round(n / step) * step;
}

async function main() {
  const landlords = await prisma.user.findMany({
    where: {
      email: { in: ["landlord@baskhuji.local", "shirin@baskhuji.local", "anwar@baskhuji.local"] },
    },
    include: { profile: true },
  });
  if (landlords.length < 3) {
    throw new Error(
      "Run `node prisma/seed.js` first — this script assumes the 3 core demo landlords already exist.",
    );
  }

  let created = 0;
  let updated = 0;
  let index = 0;

  for (let a = 0; a < AREAS.length; a++) {
    const [area, lat, lng, mult] = AREAS[a];
    for (let r = 0; r < ROOM_TYPES.length; r++) {
      const rt = ROOM_TYPES[r];
      const landlord = landlords[index % landlords.length];
      const titleTpl = pick(TITLE_TEMPLATES[rt.type], a + r);
      const title = titleTpl.replace("{area}", area);

      const jitter = ((index * 37) % 21) - 10; // -10..+10, deterministic
      const rent = round(rt.baseRent * mult * (1 + jitter / 100), 100);
      const deposit = round(rent * rt.baseDeposit, 500);
      const sqft = Math.max(
        80,
        Math.round(rt.baseSqft + (((index * 53) % rt.sqftJitter) - rt.sqftJitter / 2)),
      );
      const postedOffset = (index * 3) % 45; // spread postings over the last ~45 days
      const availableOffset = (index * 5) % 30; // available within the next ~30 days
      const id = `demo-${String(index + 1).padStart(3, "0")}`;

      const listing = {
        id,
        title,
        description: null,
        area,
        city: "Dhaka",
        latitude: lat + (((index * 7) % 9) - 4) / 2000, // tiny jitter so pins don't stack exactly
        longitude: lng + (((index * 11) % 9) - 4) / 2000,
        rent,
        deposit,
        roomType: rt.type,
        availableFrom: daysFromNow(availableOffset),
        status: "Active",
        postedOn: daysAgo(postedOffset),
        landlordId: landlord.id,
        houseRules: pick(HOUSE_RULE_SETS, a + r),
        photoUrls: [placeholderImage(`${rt.type} — ${area}`, "e5e7eb", "374151")],
        sqft,
      };

      const existing = await prisma.listing.findUnique({ where: { id } });
      await prisma.listing.upsert({
        where: { id },
        update: {
          title: listing.title,
          area: listing.area,
          latitude: listing.latitude,
          longitude: listing.longitude,
          rent: listing.rent,
          deposit: listing.deposit,
          roomType: listing.roomType,
          availableFrom: listing.availableFrom,
          status: listing.status,
          landlordId: listing.landlordId,
          houseRules: listing.houseRules,
          photoUrls: listing.photoUrls,
          sqft: listing.sqft,
        },
        create: listing,
      });
      existing ? updated++ : created++;
      index++;
    }
  }

  console.log(`✅ Demo listings done — ${created} created, ${updated} updated (${index} total).`);
  console.log(
    `   Spread across ${AREAS.length} areas × ${ROOM_TYPES.length} room types, owned by the 3 verified demo landlords.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
