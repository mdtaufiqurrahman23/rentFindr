import { compare, hash } from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "../models/prisma.js";
import { extractInviteCode } from "../services/admin-invite.js";

const AUTH_SECRET = process.env.AUTH_SECRET ?? "baskhuji-dev-secret";
const MAX_PHOTO_CHARS = 2_200_000; // ~1.6MB raw, base64-inflated

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, accountType: user.accountType }, AUTH_SECRET, {
    expiresIn: "30d",
  });
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid credentials." });

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: {
      id: true,
      name: true,
      email: true,
      passwordHash: true,
      role: true,
      profile: { select: { accountType: true } },
    },
  });
  if (!user) return res.status(401).json({ error: "Invalid email or password." });

  const ok = await compare(parsed.data.password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password." });

  const sessionUser = {
    id: user.id,
    name: user.name ?? user.email.split("@")[0],
    email: user.email,
    role: user.role,
    accountType: user.profile?.accountType,
  };

  return res.json({ token: issueToken(sessionUser), user: sessionUser });
}

const baseRegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  displayName: z.string().min(1).max(100),
  accountType: z.enum(["tenant", "landlord"]),
  requestAdmin: z.boolean().optional(),
  adminCode: z.string().optional(),
});

const landlordFieldsSchema = z.object({
  nidNumber: z.string().min(5).max(30),
  phone: z.string().min(6).max(20),
  propertyAddress: z.string().min(5).max(300),
  nidPhoto: z.string().min(1).max(MAX_PHOTO_CHARS),
  ownershipProof: z.string().min(1).max(MAX_PHOTO_CHARS),
  selfiePhoto: z.string().min(1).max(MAX_PHOTO_CHARS),
});

export async function register(req, res) {
  const parsedBase = baseRegisterSchema.safeParse(req.body);
  if (!parsedBase.success) {
    return res.status(400).json({ error: "Invalid registration payload." });
  }

  let landlordFields = null;
  if (parsedBase.data.accountType === "landlord") {
    const parsedLandlord = landlordFieldsSchema.safeParse(req.body);
    if (!parsedLandlord.success) {
      return res.status(400).json({
        error:
          "Landlord accounts require NID number, phone, property address, both document photos, and a selfie with your NID.",
      });
    }
    landlordFields = parsedLandlord.data;
  }

  let role = parsedBase.data.accountType === "landlord" ? "LANDLORD" : "TENANT";
  let claimedInviteId = null;
  if (parsedBase.data.requestAdmin) {
    const code = parsedBase.data.adminCode ? extractInviteCode(parsedBase.data.adminCode) : "";
    const staticCode = process.env.ADMIN_SIGNUP_CODE;
    const isStaticMatch = !!code && !!staticCode && code === staticCode;

    if (!isStaticMatch && code) {
      const claim = await prisma.adminInvite.updateMany({
        where: { code, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date(), usedByEmail: parsedBase.data.email },
      });
      if (claim.count === 1) {
        const invite = await prisma.adminInvite.findUnique({ where: { code } });
        claimedInviteId = invite?.id ?? null;
      }
    }

    if (!isStaticMatch && !claimedInviteId) {
      return res.status(403).json({ error: "Invalid or expired admin invite code." });
    }
    role = "ADMIN";
  }

  const existing = await prisma.user.findUnique({ where: { email: parsedBase.data.email } });
  if (existing) {
    if (claimedInviteId) {
      await prisma.adminInvite.update({
        where: { id: claimedInviteId },
        data: { usedAt: null, usedByEmail: null },
      });
    }
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  let user;
  try {
    user = await prisma.user.create({
      data: {
        email: parsedBase.data.email,
        name: parsedBase.data.displayName,
        passwordHash: await hash(parsedBase.data.password, 10),
        role,
        profile: {
          create: {
            displayName: parsedBase.data.displayName,
            accountType: parsedBase.data.accountType,
            ...(landlordFields
              ? {
                  landlordVerification: {
                    create: {
                      nidNumber: landlordFields.nidNumber,
                      phone: landlordFields.phone,
                      propertyAddress: landlordFields.propertyAddress,
                      nidPhotoUrl: landlordFields.nidPhoto,
                      ownershipProofUrl: landlordFields.ownershipProof,
                      selfiePhotoUrl: landlordFields.selfiePhoto,
                      status: "pending",
                    },
                  },
                }
              : {}),
          },
        },
      },
      select: { id: true, email: true },
    });
  } catch (err) {
    if (claimedInviteId) {
      await prisma.adminInvite.update({
        where: { id: claimedInviteId },
        data: { usedAt: null, usedByEmail: null },
      });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "An account with this email already exists." });
    }
    throw err;
  }

  return res.json({ user });
}

export async function me(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      profile: { select: { accountType: true } },
    },
  });
  if (!user) return res.status(404).json({ error: "Not found" });
  return res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    accountType: user.profile?.accountType,
  });
}
