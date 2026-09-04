import { notFound } from "next/navigation";

import { ListingDetail } from "./listing-detail";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default async function ListingDetailPage({
  params,
}: {
  params: Promise<{ listingId: string }>;
}) {
  const { listingId } = await params;

  const res = await fetch(`${API_URL}/api/listings/${listingId}/detail`, { cache: "no-store" });
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error("Failed to load listing.");
  const { listing, owner, history } = await res.json();

  return (
    <ListingDetail
      history={history}
      listing={{
        id: listing.id,
        title: listing.title,
        description: listing.description,
        area: listing.area,
        city: listing.city,
        latitude: listing.latitude,
        longitude: listing.longitude,
        rent: listing.rent,
        deposit: listing.deposit,
        roomType: listing.roomType,
        availableFrom: listing.availableFrom,
        postedOn: listing.postedOn,
        landlordId: listing.landlordId,
        houseRules: listing.houseRules,
        photoUrls: listing.photoUrls,
        sqft: listing.sqft,
      }}
      owner={owner}
    />
  );
}
