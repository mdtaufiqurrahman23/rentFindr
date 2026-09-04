import { getLandlordLeaseTimelines } from "../services/lease-timeline.js";

export async function landlordLeaseTimelines(req, res) {
  const items = await getLandlordLeaseTimelines(req.user.id);
  return res.json(items);
}
