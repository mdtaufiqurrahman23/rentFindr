// Adds demo listings for the two real-inbox demo landlords (Mahira and
// Navid's teammate accounts), separate from seed-demo-listings.js which only
// covers the 3 original @baskhuji.local landlords. Idempotent (upserts by id).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000);

function placeholderImage(label, bg = "e5e7eb", fg = "374151") {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='300'><rect width='100%' height='100%' fill='#${bg}'/><text x='50%' y='50%' font-family='sans-serif' font-size='22' fill='#${fg}' text-anchor='middle' dominant-baseline='middle'>${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const LISTINGS_BY_EMAIL = {
  "alia.mt18@gmail.com": [
    {
      idSuffix: "alia-01",
      title: "Sunny full flat with balcony, Dhanmondi 9A",
      area: "Dhanmondi",
      lat: 23.7461,
      lng: 90.3742,
      rent: 26000,
      deposit: 52000,
      roomType: "Full flat",
      sqft: 950,
      availableInDays: 10,
      houseRules: ["Family tenants preferred", "No smoking indoors"],
    },
    {
      idSuffix: "alia-02",
      title: "Compact studio near Dhanmondi Lake",
      area: "Dhanmondi",
      lat: 23.7455,
      lng: 90.3755,
      rent: 15500,
      deposit: 31000,
      roomType: "Studio",
      sqft: 340,
      availableInDays: 3,
      houseRules: ["No pets"],
    },
    {
      idSuffix: "alia-03",
      title: "Single room, walk to Rabindra Sarobar",
      area: "Dhanmondi",
      lat: 23.7468,
      lng: 90.373,
      rent: 9200,
      deposit: 18400,
      roomType: "Single room",
      sqft: 170,
      availableInDays: 15,
      houseRules: [],
    },
    {
      idSuffix: "alia-04",
      title: "Shared mess seat for students, Road 8",
      area: "Dhanmondi",
      lat: 23.7472,
      lng: 90.3748,
      rent: 6500,
      deposit: 6500,
      roomType: "Shared mess",
      sqft: 210,
      availableInDays: 1,
      houseRules: ["Students welcome"],
    },
  ],
  "mustakimarup19@gmail.com": [
    {
      idSuffix: "navid-01",
      title: "Modern full flat, Baridhara diplomatic zone",
      area: "Baridhara",
      lat: 23.7989,
      lng: 90.4198,
      rent: 38000,
      deposit: 76000,
      roomType: "Full flat",
      sqft: 1200,
      availableInDays: 20,
      houseRules: ["No smoking indoors", "No overnight guests without notice"],
    },
    {
      idSuffix: "navid-02",
      title: "Self-contained studio, Baridhara J Block",
      area: "Baridhara",
      lat: 23.8,
      lng: 90.4205,
      rent: 18000,
      deposit: 36000,
      roomType: "Studio",
      sqft: 380,
      availableInDays: 5,
      houseRules: [],
    },
    {
      idSuffix: "navid-03",
      title: "Single room with attached bath, Baridhara",
      area: "Baridhara",
      lat: 23.7982,
      lng: 90.419,
      rent: 12500,
      deposit: 25000,
      roomType: "Single room",
      sqft: 200,
      availableInDays: 2,
      houseRules: ["Quiet hours after 10pm"],
    },
    {
      idSuffix: "navid-04",
      title: "Two-seat mess room, near UN road",
      area: "Baridhara",
      lat: 23.7995,
      lng: 90.4212,
      rent: 8500,
      deposit: 8500,
      roomType: "Shared mess",
      sqft: 230,
      availableInDays: 8,
      houseRules: ["Students welcome"],
    },
  ],
};

async function main() {
  let created = 0;
  let updated = 0;

  for (const [email, listings] of Object.entries(LISTINGS_BY_EMAIL)) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.log(`⚠ Skipped ${email} — no account found.`);
      continue;
    }

    for (const l of listings) {
      const id = `demo-${l.idSuffix}`;
      const listing = {
        id,
        title: l.title,
        description: null,
        area: l.area,
        city: "Dhaka",
        latitude: l.lat,
        longitude: l.lng,
        rent: l.rent,
        deposit: l.deposit,
        roomType: l.roomType,
        availableFrom: daysFromNow(l.availableInDays),
        status: "Active",
        postedOn: daysAgo(Math.floor(Math.random() * 20) + 1),
        landlordId: user.id,
        houseRules: l.houseRules,
        photoUrls: [placeholderImage(`${l.roomType} — ${l.area}`, "e5e7eb", "374151")],
        sqft: l.sqft,
      };

      const existing = await prisma.listing.findUnique({ where: { id } });
      await prisma.listing.upsert({
        where: { id },
        update: {
          title: listing.title,
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
    }
    console.log(`✓ ${listings.length} listings ready for ${email}`);
  }

  console.log(`\n✅ Done — ${created} created, ${updated} updated.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
