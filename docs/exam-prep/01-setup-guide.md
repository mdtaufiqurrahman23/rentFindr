# rentFindr — Complete Setup Guide (Clone → Running)

This guide assumes **zero prior setup** on the machine — written for the
scenario where a teammate is doing this cold on a university lab PC that may
not have admin rights to install software.

The project is **two separate applications** that both need to be running at
once:
- **Frontend** — Next.js, at the repo root, runs on `http://localhost:3000`
- **Backend** — Express, in `backend/`, runs on `http://localhost:4000`

The frontend talks to the backend over HTTP; neither works alone.

---

## Step 0 — Check what's already on the machine

Open a terminal (Command Prompt, PowerShell, or Git Bash) and run:

```bash
node -v      # need v18 or newer — this project was built on v25
npm -v
git --version
```

- If `node`/`npm` are missing: download the installer from
  https://nodejs.org (LTS version) — no admin rights needed if you choose
  "install for current user only" during setup, or use the ZIP/portable
  build if the installer is blocked.
- If `git` is missing: https://git-scm.com/downloads — same "current user"
  install option exists.
- **Lab PC tip**: if neither can be installed and you can't get IT to install
  them, ask if the lab has a portable Node.js on a shared drive, or use
  GitHub Codespaces / a personal laptop for the exam instead — the rest of
  this guide assumes you can get *some* Node.js and Git working.

You do **not** need to install PostgreSQL locally — see Step 3, we use a free
hosted database instead, which is much friendlier to a locked-down lab PC.

---

## Step 1 — Clone the project

```bash
git clone https://github.com/mdtaufiqurrahman23/rentFindr.git
cd rentFindr
```

If you don't have push access and just need to run it, that's fine — clone
works read-only.

---

## Step 2 — Install dependencies (both apps, separately)

The frontend and backend are two separate Node projects with their own
`package.json` — you must run `npm install` in **both**.

```bash
# from the repo root (rentFindr/)
npm install

# then the backend
cd backend
npm install
cd ..
```

This takes a minute or two. `npm install` in `backend/` also automatically
runs `prisma generate` afterward (via a `postinstall` script) — that's what
makes the `@prisma/client` package actually usable; if you ever see an error
like "Cannot find module '.prisma/client'", re-run `npm install` inside
`backend/`.

---

## Step 3 — Set up a database (no local install needed)

This project uses PostgreSQL, but rather than installing a Postgres server
on the lab PC (needs admin rights, awkward to configure), get a **free
hosted database from Neon** — takes about 2 minutes, no credit card:

1. Go to https://neon.tech and sign up (free tier).
2. Create a new project (any name, e.g. "rentfindr-dev").
3. On the project dashboard, copy the **connection string** — it looks like
   `postgresql://<user>:<password>@<host>/<database>?sslmode=require`.
   Neon gives you two variants: a **pooled** one (has `-pooler` in the
   hostname) and a **direct/unpooled** one — copy both.

**Important — use your own personal Neon project for practice, not a
teammate's shared production database.** If everyone points their local dev
at the same live database, you'll each be creating/deleting test data on top
of each other (and on top of the real deployed demo site's seeded data).
Each person setting up locally should have their own database.

*(Alternative if your lab PC does allow installing software: install
PostgreSQL locally from https://www.postgresql.org/download/, create a
database, and use `postgresql://postgres:yourpassword@localhost:5432/dbname`
for both the pooled and unpooled value — for a local database there's no
real pooling distinction, so the same URL works for both.)*

---

## Step 4 — Configure environment variables

Both apps need a `.env` file — neither one is committed to git (they hold
secrets), but `.env.example` templates are.

**Frontend** (`rentFindr/.env`):
```bash
cp .env.example .env
```
Open it — it just needs one line, already correct for local dev:
```
NEXT_PUBLIC_API_URL="http://localhost:4000"
```

**Backend** (`rentFindr/backend/.env`):
```bash
cd backend
cp .env.example .env
```
Open `backend/.env` and fill in:
- `DATABASE_URL` and `DATABASE_URL_UNPOOLED` — the two connection strings
  from Step 3.
- `AUTH_SECRET` and `CRON_SECRET` — any random string works for local dev,
  e.g. run this once and paste the output in:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  (run it twice, once for each secret)
- `GEMINI_API_KEY`, `GMAIL_EMAIL`, `GMAIL_APP_PASSWORD`,
  `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD` — **leave these as the
  placeholder values from `.env.example` for now.** Every feature that uses
  them (AI drafting, email sending, payments) has a built-in fallback and
  won't crash — AI features just fall back to a deterministic template,
  emails silently no-op, and payments won't be initiable until you have a
  real Gemini key / Gmail app password / SSLCOMMERZ sandbox account. Add
  real values later if you specifically need to demo those.
- `FRONTEND_URL="http://localhost:3000"` and `BACKEND_URL="http://localhost:4000"`
  — already correct as shipped in `.env.example`.

---

## Step 5 — Set up the database schema + demo data

Still inside `backend/`:

```bash
npx prisma migrate deploy
```
This creates every table the app needs on your Neon database (18 migrations,
runs in a few seconds).

Then seed it with demo accounts and listings:
```bash
node prisma/seed.js
```
This creates ~10 demo accounts (3 verified landlords, 3 tenants, an admin,
plus a few pending/rejected landlords for testing the admin queue) and 3
listings, with realistic linked data (applications, messages, an agreement,
a payment, reviews).

Optional — if you want a lot more listings to browse/search/filter against
instead of just 3:
```bash
node prisma/seed-demo-listings.js
```
This adds 120 more listings across 30 Dhaka neighborhoods, safe to re-run.

---

## Step 6 — Run both servers

You need **two terminals open at once**.

**Terminal 1 — backend** (from `backend/`):
```bash
npm run dev
```
Wait for: `rentFindr backend listening on http://localhost:4000`

**Terminal 2 — frontend** (from the repo root):
```bash
npm run dev
```
Wait for: `Ready in ...` and `Local: http://localhost:3000`

---

## Step 7 — Verify it's working

Open http://localhost:3000 in a browser. You should see the rentFindr
homepage with active listings.

Log in with a seeded demo account to confirm the full stack works
end-to-end:

| Role | Email | Password |
|---|---|---|
| Tenant | `tenant@baskhuji.local` | `tenant123` |
| Landlord | `landlord@baskhuji.local` | `landlord123` |
| Admin | `admin@baskhuji.local` | `admin123` |

If login works and you land on `/profile` (or `/landlord` for the landlord
account) with real data showing, the setup is complete.

---

## Troubleshooting

- **"Cannot find module '.prisma/client'"** — run `npm install` again inside
  `backend/` (its `postinstall` script runs `prisma generate`).
- **"Port 3000/4000 is in use"** — something else is already running there.
  Next.js will auto-pick a different port (e.g. 3001) and print it — but
  then the frontend's `NEXT_PUBLIC_API_URL` and the backend's `FRONTEND_URL`
  need to match whatever ports you actually end up on, or login will fail
  with CORS errors. Easiest fix: find and close whatever's using the port,
  then restart both servers on 3000/4000.
- **Login succeeds but every page after shows a 401 / redirects to `/auth`**
  — check the backend terminal for errors; usually means `DATABASE_URL` is
  wrong or the migrations weren't applied (re-run Step 5).
- **CORS error in the browser console** — `backend/.env`'s `FRONTEND_URL`
  must exactly match the URL the frontend is actually running on (protocol +
  host + port).
- **Gemini/email/payment features "don't work"** — expected if you left
  those env vars as placeholders (Step 4). Everything else works fine.
