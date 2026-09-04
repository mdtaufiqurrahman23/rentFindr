import { Router } from "express";
import {
  createListing,
  listListings,
  getListing,
  getListingDetail,
  updateListing,
  getMyListings,
  compareListings,
  toggleSaveListing,
  getSaveStatus,
} from "../controllers/listing.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/error.middleware.js";

export const listingRoutes = Router();

// Specific/static paths must be registered before the ":listingId" param
// route below, or Express would match e.g. "mine"/"compare"/"save" as an id.
listingRoutes.get("/mine", requireAuth, asyncHandler(getMyListings));
listingRoutes.get("/compare", requireAuth, asyncHandler(compareListings));
listingRoutes.post("/save", requireAuth, asyncHandler(toggleSaveListing));
listingRoutes.get("/save", asyncHandler(getSaveStatus)); // optional auth, handled in controller

listingRoutes.get("/", asyncHandler(listListings));
listingRoutes.post("/", requireAuth, asyncHandler(createListing));

listingRoutes.get("/:listingId/detail", asyncHandler(getListingDetail));
listingRoutes.get("/:listingId", asyncHandler(getListing));
listingRoutes.patch("/:listingId", requireAuth, asyncHandler(updateListing));
