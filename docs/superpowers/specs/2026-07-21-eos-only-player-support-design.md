# EOS-only Player Support — Design

**Date:** 2026-07-21
**Status:** Approved (design), pending implementation plan
**Repos touched:** SquadJS-Royal-battalion, RoyalSecretaryDiscordBot, RoyalBattalionWebpage

## Problem

Squad players are identified by either a Steam ID (SteamID64) or an Epic Online
Services ID (`eosID`). A subset of players — Epic Games Store users — have **no
Steam ID at all** ("Epic-only players"). The framework core is already EOS-keyed
(`squadjs_players.eos_id` is `NOT NULL UNIQUE`, lookups are by EOS), but several
plugins and the whitelist chain still assume a Steam ID is always present, so
Epic-only players are only partially supported.

An audit found:

| Area | State for Epic-only players |
|---|---|
| Play / connect / spawn / combat logging | Works (EOS-keyed via `ensurePlayer`) |
| Killfeed / stats / scoreboard | Works |
| Team balancer clan lookup (`team-balancer.js:331`) | Broken — clan silently missed |
| Auto-disband exempt list (`auto-disband-early-squads.js:513`) | Broken — can't be exempted |
| CBL warn/info (`cbl-admin-warn.js:60`, `cbl-info.js:52`) | Skipped by design (CBL is Steam-only) |
| Seed whitelist read (`seed-tracker.js:556`) | Steam-keyed — unreachable for Epic-only |
| In-game whitelist reward | Not possible — game matches `admins.cfg` on Steam |

## Goal

Make Epic-only players first-class for **tracking, stats, team balance, and
identity**, and build the **Discord↔EOS identity link** plus **graceful
whitelist-reward messaging** for them.

## Key Constraint & Boundary (flagged risk)

`admins.cfg` **stays Steam-only.** The webpage's `cfg-generator.ts:56` emits
`Admin=${e.steamId}:${group}`, and all current Squad documentation (official
wiki, host docs, GameServerManagers template) documents `Admin=<SteamID64>:<Group>`
with **no mention of EOS IDs**. Whether the game's `admins.cfg` parser accepts an
EOS ID is unverified; we are deliberately **not** depending on it.

**Consequence, stated plainly:** this feature does **not**, by itself, let an
Epic-only player receive an in-game whitelist — the game has no ID to match them
on. What it delivers is (a) correct identification of Epic-only players across
stats/balance/dashboard, and (b) the identity + messaging foundation so that the
day `admins.cfg` gains EOS support (or the player links a Steam account), the
grant path is ready.

Because we do not touch `admins.cfg`, **no pre-implementation staging test is
required.**

## Non-goals

- Converting `admins.cfg` to EOS.
- Changing CBL behaviour (Steam-only is intrinsic to Community Ban List).
- Unlocking the in-game whitelist reward for Epic-only players (explicitly out;
  documented as an inherent limitation while the cfg is Steam-only).

## Existing infrastructure this builds on

- `User.eosId` already exists in the webpage schema (`@unique`), and a daily
  `eos-backfill.ts` job fills it from `squadjs_players` matched on `steam_id`.
  Therefore the **only** population that needs a linking flow is genuinely
  Steam-less Epic players (everyone with a Steam ID gets an EOS backfilled).
- The Discord bot already consumes SquadJS `CHAT_MESSAGE` events over socket.io
  (`seedingSocket.js:183-192`), and that event carries `eosID` + `steamID`.
- SquadJS already routes `!command` chat into `CHAT_COMMAND:<name>` events with
  full player identity attached (`squad-server/index.js`).
- The Steam link flow (`/link-steam`, `steamLinkButtons.js`, `userService.js`)
  is the production pattern the EOS link mirrors.

---

## Part A — SquadJS EOS-cleanliness fixes (SquadJS-only, small)

**A1. Team balancer clan lookup** — `squad-server/plugins/team-balancer.js:331`
Currently `clanBySteam.get(p.steamID)` — `undefined` for Epic-only players.
Build a `clanByEos` map alongside `clanBySteam` and resolve:
`clanBySteam.get(p.steamID) ?? clanByEos.get(p.eosID)`.
Clan source data must expose EOS to populate `clanByEos`; if the clan source is
Steam-keyed only, resolve EOS→Steam via `squadjs_players`/`User` during map
construction. Covered by existing `balancer-core` unit tests (extend for the
EOS path).

**A2. Auto-disband exempt list** — `squad-server/plugins/auto-disband-early-squads.js:513`
`isExemptPlayer(steamID)` must also match on `eosID`. Extend the exempt lookup
to check both identifiers.

**A3. CBL warn/info** — no change. Steam-only skip is intrinsic and already
graceful.

Parts A1–A3 are independent of B and C and independently shippable.

---

## Part B — Discord↔EOS linking (new feature; in-game code verification)

EOS IDs are opaque and not user-visible (unlike a SteamID64 derivable from a
profile URL), so ownership is proven **in-game**.

**B1. Code generation (bot).** New `/link-epic` command (button + modal,
mirroring `/link-steam`). On invoke:
- Reject if the user already has a linked `eosId` (dedupe like Steam).
- Generate a one-time 6-char alphanumeric code.
- Persist to a **new bot-DB table** `eos_link_codes` in `Royal_secretary`
  (`code`, `discord_id`, `expires_at`), 10-minute TTL. DB-backed, not in-memory
  (active-dev restarts must not wipe pending links).
- DM the user: *"Join the server and type `!linkeos <CODE>` in chat."*

**B2. Relay + verification (bot, via existing socket).** The bot already
receives `CHAT_MESSAGE` (carrying `eosID`/`steamID`) over the SquadJS socket.
The bot parses `!linkeos <code>`, then:
- Looks up the code in `eos_link_codes`; rejects if missing/expired.
- Resolves `discord_id` from the code, writes `User.eosId = eosID` on the
  website DB (and back-fills `User.steamId` if the player has one and it is
  currently unlinked). Uses the same "never overwrite an existing link" upsert
  guard as the Steam flow.
- Handles the `@unique` conflict (this `eosID` already belongs to another user)
  gracefully — logged and reported, not a crash.
- Deletes the used code and DMs the initiating user the result
  (success/failure). No in-game feedback required.

**B3. SquadJS change — contingent.** If the socket broadcast already includes the
ID fields on `CHAT_MESSAGE` (expected, per `seedingSocket.js`), **SquadJS needs
no change.** If verification shows the ID fields are stripped from the socket
payload, the fallback is a ~10-line SquadJS emit of a dedicated
`eos-link-attempt` `{ code, eosID, steamID, name }` event on the existing socket
server. This is confirmed during implementation, not assumed.

**Security.** The code is one-time, short-TTL, and bound to the `discordId` that
generated it; it links to whichever `eosID` typed it in-game. Public chat
visibility is acceptable because the code is single-use and expires quickly.

---

## Part C — Whitelist reward: graceful handling for Epic-only

**C1. Schema.** Add nullable `eosId` (+ index) to `WhitelistEntry`
(`prisma/schema.prisma`). The `@@unique([steamId, server])` constraint is
retained; Epic-only entries carry a null `steamId` and a set `eosId`.

**C2. Grant/read paths.** `upsertSeederEntry` and `getSeederWhitelistExpiry`
(and analogous member/SL paths) match on `steamId` **or** `eosId`.

**C3. Emission stays Steam-only.** Because `admins.cfg` is unchanged, an
Epic-only `WhitelistEntry` (null `steamId`) is **stored/tracked but not emitted
to the game** — `cfg-generator.ts` continues to iterate Steam entries. This is
intentional tracking + future-proofing, not an in-game grant.

**C4. Graceful messaging.** When a seed/other reward is earned by a player who
has a linked EOS but no Steam, instead of silently dropping the reward the
grant path **DMs the Discord user** (resolved via `User.eosId = eosID`):
*"You earned a seed whitelist — link a Steam account via `/link-steam` to claim
it in-game."* Part B is the enabler: without the Discord↔EOS link there is no
Discord user to DM.

---

## Data flow (linking + reward)

```
/link-epic (DM)  -> bot generates code -> eos_link_codes (bot DB) + DM instructions
player types !linkeos CODE in-game
  -> SquadJS CHAT_MESSAGE (eosID, steamID) -> socket -> bot
  -> bot validates code -> User.eosId = eosID (website DB) -> DM result

seed reward earned (Epic-only, EOS linked, no Steam)
  -> WhitelistEntry stored with eosId (not emitted to cfg)
  -> bot DMs "link Steam to claim in-game"
```

## Testing

- `balancer-core` unit tests extended for the clan-by-EOS resolution (A1).
- Unit tests for code generation, validation, expiry, and unique-conflict (B1/B2).
- Simulated `CHAT_MESSAGE` exercising the relay parse + link (B2).
- Manual staging run of the full link → earn → DM path (B + C4).

## Rollout notes

- Bump semver in each repo's `package.json` before each push (bot from 2.x,
  webpage from 1.x/2.x).
- Conventional Commits, one-liners, no AI attribution.
- Slash command `/link-epic` must be manually registered after deploy
  (`docker exec royal-secretary-bot-{staging,prod} bun run deploy-commands`);
  CI does not register commands.
- New `WhitelistEntry.eosId` column self-applies on webpage boot via the API
  entrypoint's `prisma db push`.
- Parts A, B, C are decoupled; A and C are independently shippable, B enables
  C4's messaging.
