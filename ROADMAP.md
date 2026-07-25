# Sheepshead — Feature Roadmap

Working hypothesis this roadmap is built to test first: **will the friend group actually
play together, on a whim, without a scheduled event?** Everything in "Now" is scoped to
prove that before anything else gets built. See the interview notes at the bottom for
the reasoning this is built from.

Format: Feature → Epic → User Story. IDs are stable references for commits/issues
(e.g. a commit implementing guest-name join can say `MP-3.1`).

---

## NOW

### Feature: Multiplayer (`MP`)
Core mechanic — get a live table running with friends and AI, with zero friction to
join. This is the plumbing; Community (below) is what makes it feel like hanging out.

#### Epic MP-1: Shareable Table Links
- **MP-1.1** As a host, I want to create a new table in one click, so I can start a
  game with no setup.
- **MP-1.2** As a host, I want a unique link generated for that table, so I can text
  it straight to the group.
- **MP-1.3** As a friend, I want to click the link and land directly in the table —
  no app download, works in a mobile browser — so joining is as easy as a Zoom link.
- **MP-1.4** As a host, I want to see who's joined in real time as the link gets
  clicked, so I know when to start.
- *Scope note:* links are ephemeral / tied to a live session for Now. Persistent,
  reusable group links are `Next` (see Community groups below).

#### Epic MP-2: AI Seat-Fill
- **MP-2.1** As a host, I want any unfilled seat auto-staffed by an AI opponent, so
  the table is playable the instant one human shows up — no minimum headcount.
- **MP-2.2** As any player, I want to clearly see which seats are AI vs. human, so I
  know who I'm actually playing with.
- **MP-2.3** As a latecomer, I want to be able to take over an AI seat at the next
  natural break (between hands, not mid-trick), so joining late never disrupts a
  hand in progress.
- **MP-2.4** As a host, I want the game to run smoothly at any human/AI mix — 1
  human + 4 AI up through 5 humans + 0 AI — so partial attendance never breaks
  anything.

#### Epic MP-3: Guest Join
- **MP-3.1** As a friend clicking a link, I want to type a display name and be
  seated — no account, no password — so joining takes five seconds.
- **MP-3.2** As a returning guest on the same device, I want my name remembered, so
  I don't retype it every time.
- **MP-3.3** As a player, I want friendly names/avatars at the table (not "Player
  1"), so it feels personal — matching how the AI opponents already have real names
  (Gus, Bunny, Duane, Patty).
- **MP-3.4** As a player, I want basic protection against duplicate names at one
  table, so there's no confusion about who's who.

---

### Feature: Community (`COM`)
The social layer. This is the actual emotional engine, per the interview — protect it
accordingly; don't let it slip to "later."

#### Epic COM-1: Embedded Voice/Video
- **COM-1.1** As a player, I want a live voice/video room available the moment a
  table is created, so we can hear/see each other without a separate Meet link.
- **COM-1.2** As a player, I want to mute or go camera-off easily, so I can listen
  only or step away without being on camera.
- **COM-1.3** As a player, I want voice/video to reuse my guest identity, so there's
  no second signup.
- **COM-1.4** As a player on a phone, I want voice/video to work reasonably well in
  a mobile browser, matching the mobile-first work already done on layout.
- *Build note:* embed an existing solution (e.g. a Jitsi room per table, or an
  auto-generated video link) rather than building custom WebRTC infra for v1 — the
  goal is testing the hypothesis fast, not owning video infrastructure.

#### Epic COM-2: Presence
- **COM-2.1** As a friend with the table link, I want to see who's online / at the
  table right now, so I know it's "worth hopping on" without texting to ask.
- **COM-2.2** As a player, I want a signal when someone starts or joins "our" table,
  so spontaneous games can form without manual cajoling.
- *Dependency note:* COM-2.1 works fine on ephemeral guest sessions. COM-2.2 as a
  real push notification likely needs persistent accounts (`Next`) — flag this if it
  turns out to be a bigger lift than expected, and fall back to in-app-only signal
  for Now.

#### Epic COM-3: Seamless Seat Cover
- **COM-3.1** As a player stepping away mid-hand or between hands, I want to pass my
  seat to AI in one action, so the game doesn't stall the group.
- **COM-3.2** As a player who stepped away, I want to reclaim my seat easily when
  I'm back, so I don't lose my spot.
- **COM-3.3** As another player, I want a clear indicator that a seat is "AI
  covering for [name]" vs. a full AI opponent, so we understand the social context.
- **COM-3.4** As a host, I want the game to never stall waiting on someone who
  stepped away without covering, so one AFK player can't freeze the table.

---

## NEXT (not yet broken into epics/stories)
- Lightweight persistent accounts (stats, history, "who's online" survive sessions)
- Push notifications proper (depends on accounts)
- Seat bench/queue for 6-7 person nights (the get61 failure mode)
- Persistent private groups with a running scoreboard (vs. one-off table links)
- Recap / best-worst-play history saved per player over time

## LATER (directional)
- Public tables + matchmaking for strangers
- Rating system
- Tutorial / guided onboarding for brand-new players (protected scope — see below)
- Daily puzzle, shareable recap cards
- Subscription tier (clubs, deep history, cosmetics)

---

## Protected scope: Learn-to-play tutorial
Deliberately sequenced after Now/Next, not because it's low priority — it's core to
the long-term "grow the worldwide community" goal — but because it only pays off once
there's somewhere to send a new player (public tables, which are `Later`). Architecture
constraint to protect it: multiplayer must be built as an *additional* mode alongside
the existing local solo-vs-AI mode, reusing `engine.js` (already pure, UI-free) for
both — not a rewrite that entangles local and networked state. Tutorial mode will slot
in later the same way solo mode works today: no backend, no network dependency,
instant to try.

## Foundational technical dependencies
- **Realtime backend** for live table/seat state sync — the app currently has zero
  backend. Candidates: Supabase (Postgres + Realtime + Auth) or a dedicated room
  server built for this pattern (e.g. Colyseus). This underlies all of `MP`.
- **Voice integration approach** — embed (Jitsi / generated link) vs. custom WebRTC.
  Recommendation: embed for v1, revisit only if limits actually bite.

---

## Why this is sequenced this way (interview notes, 2026-07-24)
The group ran a biweekly Thursday Sheepshead night during the pandemic on get61.com +
a separate Google Meet, coordinated over text/Google Chat. It failed more often than it
succeeded — not from lack of interest, but because a *scheduled* commitment kept losing
to spontaneous life events, and getting 5 people to commit in advance was the actual
bottleneck. On the best nights, 6-7 people wanted in and the existing tool couldn't
gracefully rotate people through 5 seats. The Google Meet — not the card game — was
doing the real emotional work; the game was "an excuse to fill the quiet spaces."
Everything in `Now` targets removing the coordination tax (AI-filled seats mean no
minimum headcount, shareable links replace group-text cajoling, presence replaces
manually asking around) while making the voice/social layer first-class rather than a
bolted-on second tool.
