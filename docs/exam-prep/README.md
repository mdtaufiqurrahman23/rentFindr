# CSE471 Live Modification Exam — Study Pack

Prep material for the "Live Modification Task" exam. Written directly
against the real, current codebase (not summaries) — every code excerpt is
copied verbatim from the actual files.

## Contents

1. **[Setup Guide](01-setup-guide.md)** — clone → install → configure → run,
   written for a teammate starting from zero on a fresh machine (including a
   lab PC with no admin rights and no local PostgreSQL).
2. **Code walkthroughs**, one per member — how each feature actually works,
   with real code excerpts and the exact frontend↔backend wiring:
   - **[Navid Mustakim Arup](02-walkthrough-navid.md)** — Trust, Discovery & Verification (listings, search & ranking, analytics, landlord verification, match score, history panels, saved listings)
   - **[Md Taufiqur Rahman](03-walkthrough-taufiqur.md)** — Transactions & Legal Documentation (agreement generator, payments, move-out settlement, expiry reminders, lease timeline, improvement cost log)
   - **[Mahira Tun Alia](04-walkthrough-mahira.md)** — Communication, Community & Resolution (roommate matching, maintenance SLA, reviews, Smart Evidence Resolution, messaging)
3. **[Practice Exam Sets](05-practice-exams.md)** — 2 full practice sets per
   member (mirrors the real exam's 2-task format), each with a complete
   worked answer: which files to touch, schema changes, and real code.

## How to use this during review

- Read your own member's walkthrough first — an examiner can ask you to
  trace a value from a button click all the way into the database, so read
  the code excerpts closely rather than skimming the prose.
- Then do your own practice sets **closed-book** — try to name the files and
  write the core logic yourself before checking the answer.
- The walkthroughs flag a few honest gaps/quirks in the real code (e.g. a
  weighted Trust Score component that's always `null` because no
  dispute-outcome model exists yet, or an export feature that's wired up on
  two pages but not a third). If an examiner probes exactly those spots,
  the answer is "that's a known gap, here's why" — not something to hide.

## If setting up fresh (e.g. a lab PC)

Follow the [Setup Guide](01-setup-guide.md). You do **not** need to install
PostgreSQL locally — it walks through using a free hosted Neon database
instead, which needs no admin rights on the machine.
