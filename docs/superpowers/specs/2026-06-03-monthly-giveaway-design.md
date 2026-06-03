# Monthly Game Giveaway — Design

**Date:** 2026-06-03
**Owner:** Ole
**Requester:** Onion (Trainee Admin)
**Status:** Draft for review

## Purpose

Onion has been running ad-hoc monthly game giveaways in `#royal-lounge` for two months and wants the bot to formalize it. The system rewards engagement on RB servers: more time played and more time seeding means more raffle tickets, with an RB-only community vote adding a small bonus for members who went above and beyond.

This spec covers an **RB-members-only** giveaway for the first release. Opening it to the broader community requires Discord↔Steam linking for non-members, which is deferred to a later spec.

## Requirements (locked)

- **Tickets** = `playedHours × 1 + seedHours × 2 + votes × 1`
- **Eligibility floor:** 5 hours played on RB in the last 30 days
- **Community vote:** RB members only; each voter casts up to 2 votes, must be for 2 *different* people (no double-voting one entrant)
- **Vote post visibility:** RB channel only for v1
- **Non-RB entries:** staff manual entry only (`/giveaway add-entry`)
- **Hours snapshot timing:** computed at draw time (entry post shows static rules; live numbers via `/giveaway leaderboard`)
- **Entry gating:** eligibility checked at button click, not at draw time (clearer UX)

## Architecture

Follows the bot's existing service-per-feature convention. All new files; no rewrites of existing modules. State lives in MariaDB (`Royal_secretary` / `secretary` pool) — no in-memory caches, per [feedback_no_in_memory_state].

### Module layout

```
src/
├── commands/
│   └── giveaway.js                       NEW — slash command, six subcommands
├── handlers/
│   └── giveawayButtons.js                NEW — Enter button + vote buttons
├── services/
│   └── giveaway/
│       ├── giveawayService.js            NEW — DB + business logic
│       ├── giveawayEmbeds.js             NEW — embed + button builders
│       └── giveawayDraw.js               NEW — weighted random + result post
└── database/
    └── schema.js                         EDIT — three new CREATE TABLE blocks
```

### Reused modules

- `playtimeService.getPlaytime(steamId, startDate)` → `{ playtimeHours, seedHours }` from SquadJS
- `userService.getStoredSteamId(discordId)` → Steam ID from website's `User` table
- `query(sql, params, poolName)` with `poolName='secretary'` for own data, `'squadjs'` for game data, `'website'` for Discord↔Steam link

### Handler routing

`giveawayButtons.js` registers customId prefixes with `interactionCreate.js`:
- `giveaway_enter:<giveawayId>` — Enter button on entry post
- `giveaway_vote:<giveawayId>:<targetUserId>` — vote button on vote post

Drop-in registration in the routing map; no other handlers touched.

## Data model

Three new tables in `Royal_secretary`:

```sql
CREATE TABLE giveaways (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  prize           VARCHAR(255) NOT NULL,
  month_label     VARCHAR(20) NOT NULL,        -- e.g. "May 2026"
  scope           ENUM('rb_only','community') DEFAULT 'rb_only',
  status          ENUM('open','voting','drawn','cancelled') DEFAULT 'open',
  draw_at         TIMESTAMP NOT NULL,
  window_days     INT DEFAULT 30,              -- look-back for hours
  min_hours       DECIMAL(5,2) DEFAULT 5.00,   -- eligibility floor
  hours_weight    DECIMAL(4,2) DEFAULT 1.00,   -- tickets per played hour
  seed_weight     DECIMAL(4,2) DEFAULT 2.00,   -- tickets per seeded hour
  vote_weight     INT DEFAULT 1,               -- tickets per vote
  votes_per_voter INT DEFAULT 2,               -- max votes per RB member
  entry_channel_id  VARCHAR(20),
  entry_message_id  VARCHAR(20),
  vote_channel_id   VARCHAR(20),
  vote_message_id   VARCHAR(20),
  winner_user_id  VARCHAR(20) NULL,
  created_by      VARCHAR(20) NOT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  drawn_at        TIMESTAMP NULL
);

CREATE TABLE giveaway_entries (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  giveaway_id    INT NOT NULL,
  user_id        VARCHAR(20) NOT NULL,        -- Discord ID
  steam_id       VARCHAR(20) NULL,            -- nullable for manual entries
  manual_hours   DECIMAL(6,2) NULL,           -- non-null iff manual entry
  manual_seed    DECIMAL(6,2) NULL,
  added_by       VARCHAR(20) NULL,            -- non-null iff manual
  entered_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_entry (giveaway_id, user_id),
  FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
);

CREATE TABLE giveaway_votes (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  giveaway_id  INT NOT NULL,
  voter_id     VARCHAR(20) NOT NULL,
  target_id    VARCHAR(20) NOT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vote (giveaway_id, voter_id, target_id),
  INDEX idx_voter (giveaway_id, voter_id),
  FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
);
```

### Design notes

- All rules (`min_hours`, weights, `votes_per_voter`) live on the giveaway row, so Onion can adjust month-to-month without code edits.
- `UNIQUE KEY uq_vote (giveaway_id, voter_id, target_id)` enforces no-double-voting-same-person at the DB level.
- `manual_hours` / `manual_seed` cleanly distinguish staff-added entries from live SquadJS pulls.

## Commands & UX

One slash command, six subcommands. "Staff" = has the `memberRoleId` defined in `settings.prospects.memberRoleId` (the RB member role).

| Subcommand | Permission | Behavior |
|---|---|---|
| `/giveaway start prize:<text> channel:<#chan>` | Staff | Insert `giveaways` row (status `open`, `draw_at` = last day of current month 23:59 UTC). Post entry embed with Enter button. Refuses if another `open` giveaway exists. |
| `/giveaway add-entry user:<@user> hours:<n> seed:<n>` | Staff | Upsert manual entry. Updates `manual_hours`/`manual_seed` if entry exists. |
| `/giveaway leaderboard` | Anyone | Ephemeral. Top-20 by computed tickets (live SquadJS pull). |
| `/giveaway open-vote [channel:<#chan>]` | Staff | Transitions `open` → `voting`. Posts custom vote embed with one button per entrant in `channel:` (defaults to entry channel). Use a separate RB-only channel here for v1. |
| `/giveaway draw` | Staff | Snapshot hours, compute weighted random, post winner embed, transition to `drawn`. Idempotent: refuses if `winner_user_id` set. |
| `/giveaway cancel` | Staff | Set status `cancelled`, attempt to delete entry/vote messages. |

### Vote post structure

Custom embed (not Discord native poll — native polls cap at 10 options and don't support our per-voter-cap rule). One button per entrant, up to 25 (5 rows × 5 buttons). For >25 entrants we paginate with prev/next buttons; expected real-world entrant count is well under 25, but the cap is hard so the pagination path must exist.

Pattern mirrors `prospectVoting.js`.

### Enter button flow

1. Click → ephemeral defer
2. Resolve `steamId` via `getStoredSteamId(discordId)`
3. If no link → ephemeral: "Link your Steam first using the verify panel" (link to the verify panel message; URL resolved at runtime from `config.verify.panelMessageId`)
4. Pull live `getPlaytime(steamId, today - window_days)`
5. If `playtimeHours < min_hours` → ephemeral: "You need 5h played in the last 30 days. You have Xh."
6. Insert into `giveaway_entries` (`steam_id` set, `manual_*` null)
7. Ephemeral confirm with current ticket count

### Vote button flow (RB-only)

1. Click → ephemeral defer
2. Verify caller has RB role; else ephemeral: "RB members only."
3. Count caller's votes for this giveaway; if `>= votes_per_voter` → "Out of votes (used 2/2)."
4. Try insert into `giveaway_votes`; on unique-key violation → "You already voted for this entrant."
5. Ephemeral confirm with `(votesRemaining)`

## Draw algorithm

```js
// Pseudo
for (const entry of entries) {
  const hours = entry.manualHours ?? (await getPlaytime(entry.steamId, windowStart)).playtimeHours;
  const seed  = entry.manualSeed  ?? (await getPlaytime(entry.steamId, windowStart)).seedHours;
  const votes = await countVotes(giveawayId, entry.userId);
  entry.tickets = Math.floor(hours * hoursWeight + seed * seedWeight + votes * voteWeight);
}

const total = entries.reduce((s, e) => s + e.tickets, 0);
const roll = Math.random() * total;
let cum = 0;
const winner = entries.find(e => (cum += e.tickets) >= roll);
```

`Math.random()` is fine here — this is a fun community raffle, not security-sensitive.

Idempotency: persist `winner_user_id` immediately on draw. Re-runs of `/giveaway draw` short-circuit if already set.

Result embed shows: winner mention, their ticket count, total tickets, total entrants, top-5 ticket holders for transparency.

## Edge cases

| Case | Handling |
|---|---|
| User leaves Discord between Enter and Draw | Keep in draw. If winner, fall back from DM to public mention in giveaway channel. |
| Steam relink between Enter and Draw | Use the `steam_id` stored on the entry row, not the current link. Fairness lock. |
| 3rd vote attempt by same RB member | Blocked at app layer (count check); DB unique key catches dupes if race. |
| `/giveaway start` while one is `open` | Refuse with current giveaway's message link. |
| Bot restart mid-month | Full recovery from DB; no in-memory state. |
| Manual entry voting | A manual entry CAN be voted on (Onion's whole point). They can only vote themselves if they have an RB role. |
| Manual entry on existing row | Update `manual_hours`/`manual_seed`; do not duplicate. Log as audit event. |
| Entrant with 0 votes and 0 manual + 0 played hours | `tickets = 0`. Stays in entries list but cannot win (weight 0). |
| Total tickets = 0 (no eligible entries) | `/giveaway draw` refuses with "No eligible entries." |
| More than 25 entrants for vote post | Paginate vote buttons across multiple messages or with prev/next controls (5×5 = 25 button cap per message). |
| `/giveaway open-vote` with 0 entrants | Refuse with "No one has entered yet." |

## Testing

- **Unit (`tests/unit/giveawayDraw.test.js`)**: weighted-random distribution, idempotency on re-draw, 0-ticket exclusion.
- **Service (`tests/unit/giveawayService.test.js`)**: entry upsert (manual vs linked), vote insert + unique-key violation, eligibility check.
- **Integration (manual on staging)**: full flow — `/giveaway start` → 3 test entries (1 linked, 1 manual, 1 ineligible) → `/giveaway open-vote` → 2 RB voters → `/giveaway draw` → verify winner embed and DB state.

No prod DB hits in tests — follows the bot's existing pattern of mocking the `query()` adapter.

## Out of scope (future specs)

- Self-serve Discord↔Steam linking flow (multi-day dev, blocks community-wide v2)
- Community-wide giveaway scope (`scope = 'community'`)
- Webpage UI for giveaway management or public leaderboard
- Auto-scheduled month-end draws (cron) — can be added trivially once manual flow is proven
- Multi-prize giveaways (1st/2nd/3rd)
- Anti-fraud audit log for vote manipulation (current trust model: RB-only voting limits abuse surface)

## Open questions

None at design time — all locked with Onion in the originating Discord thread.
