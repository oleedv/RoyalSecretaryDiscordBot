# Monthly Giveaway — Manual Integration Test Checklist (Production)

> Run this against the live production guild after the GitHub Actions deploy completes and `/giveaway deploy-commands` has run on the VPS. Bot must be running v2.5.0 (`docker ps` shows fresh container restart).

## Prerequisites

- [ ] CI pipeline shows "Deployed" notification in the deploy-webhook channel
- [ ] `docker ps --filter name=royal-secretary-bot-prod` shows `Up <minutes>` (recently restarted)
- [ ] Slash command `/giveaway` autocompletes in Discord (re-register if missing — see Task 21 in the plan)

## Pre-flight DB check

Run on the VPS — confirm the three new tables exist:

```bash
ssh user@your-server \
  "docker exec mariadb mariadb -u root -p\"\$MARIADB_ROOT_PASSWORD\" Royal_secretary_prod -e 'SHOW TABLES LIKE \"giveaway%\"'"
```

Expected: three rows — `giveaways`, `giveaway_entries`, `giveaway_votes`.

(You may need to substitute the actual root password if the env var isn't set on the VPS — schema is also applied on bot boot, so if the bot is healthy this is informational only.)

## Walkthrough

Use a test/admin channel everyone can hide later (or `#bot-testing` if it exists). You'll need:
- Your own account (linked Steam, has playtime on RB main)
- A 2nd RB member's account for the second vote (or a 2nd member willing to click a button)
- A 3rd Discord user who is NOT linked (or use a manual entry)

### Step 1 — Create the giveaway

Run in your chosen channel:
```
/giveaway start prize:"Test Prize - Ole's Verification" channel:#<that channel>
```

Expected:
- Ephemeral reply: `Giveaway #N posted in #<chan>. Prize: Test Prize - Ole's Verification`
- Public embed in the channel titled `RB Member Game Giveaway — June 2026` with:
  - Prize line
  - Three ticket-weight bullets (1 / +2 / +1)
  - "Minimum to enter: 5h played in the last 30 days."
  - "Draw: <timestamp for last day of June>" (Discord renders the timestamp)
  - "Entries so far: 0"
  - One blue `Enter Giveaway` button with ticket emoji

Failure modes to watch:
- ❌ Bot replies with "Something went wrong" → check bot logs (`docker logs --tail 50 royal-secretary-bot-prod`).
- ❌ Embed missing → bot doesn't have permission to send in the channel.

### Step 2 — Enter (linked-Steam user)

Click the `Enter Giveaway` button as your own account (linked Steam, ≥5h on main).

Expected ephemeral reply:
- Title `Entered!` (green)
- "You currently have **N** tickets (Xh played + 2×Yh seeding)."
- "Vote post opens later this month."

If your Steam isn't linked → ephemeral says "You need to link your Steam account first using the verify panel." (this means the linking step is still required — exit and link first).

If your hours are <5 → ephemeral says "You need at least 5h played on RB in the last 30 days. You have Xh."

DB check (optional):
```bash
ssh user@your-server \
  "docker exec mariadb mariadb -u root -p\"\$MARIADB_ROOT_PASSWORD\" Royal_secretary_prod \
   -e 'SELECT user_id, steam_id, manual_hours FROM giveaway_entries ORDER BY id DESC LIMIT 5'"
```

Expected: row with your `user_id`, your `steam_id`, `manual_hours = NULL`.

### Step 3 — Enter (unlinked user)

Have someone without a linked Steam click the button.

Expected: ephemeral "You need to link your Steam account first using the verify panel."

### Step 4 — Add a manual entry

```
/giveaway add-entry user:@SomeoneElse hours:50 seed:10
```

Expected ephemeral:
- `Added/updated manual entry for @SomeoneElse: 50h played, 10h seed.`

DB check:
```bash
ssh user@your-server \
  "docker exec mariadb mariadb -u root -p\"\$MARIADB_ROOT_PASSWORD\" Royal_secretary_prod \
   -e 'SELECT user_id, manual_hours, manual_seed, added_by FROM giveaway_entries WHERE manual_hours IS NOT NULL'"
```

Expected: row with `manual_hours = 50.00`, `manual_seed = 10.00`, `added_by = <your discord id>`.

### Step 5 — Re-run add-entry (upsert check)

```
/giveaway add-entry user:@SomeoneElse hours:75 seed:15
```

Expected: success. DB should now show `manual_hours = 75.00`, `manual_seed = 15.00` (updated, not duplicated). Row count for that user_id should still be 1.

### Step 6 — Leaderboard

```
/giveaway leaderboard
```

Expected ephemeral embed `Leaderboard — June 2026`:
- Line 1: your entry with computed tickets (hours×1 + seed×2 + 0 votes)
- Line 2: the manual entry — `75h + 2×15h seed + 0 votes` = `105` tickets, with `*(manual)*` tag

Footer: `Total entries: 2`.

### Step 7 — Open the vote

```
/giveaway open-vote
```
(Omitting `channel:` so it defaults to the entry channel — for real use, pass an RB-only channel.)

Expected:
- Ephemeral: `Vote post opened in #<chan> (1 message).`
- Public embed `Community Vote — June 2026` with:
  - "Who has gone above and beyond for the community this month?"
  - "You can vote for up to **2** different entrants."
  - Two gray buttons: one labeled with your display name, one with SomeoneElse's display name.

DB check: `giveaways.status` should now be `voting`.

### Step 8 — Vote for self (rejection check)

Click the button with your OWN name.

Expected ephemeral: red embed "You cannot vote for yourself."

### Step 9 — Vote for someone else

Click SomeoneElse's name button.

Expected ephemeral (green): `Vote recorded for @SomeoneElse. You have 1 vote(s) left.`

### Step 10 — Vote again for the same person (dedupe check)

Click SomeoneElse's button a second time.

Expected ephemeral (red): "You already voted for this entrant."

### Step 11 — Cap check

If you have a 2nd entrant available, vote for them too. Then try a 3rd vote. Expected (red): "You've used all 2 of your votes."

If you only have 2 entrants, this case can't be hit yet — skip.

### Step 12 — Run the draw

```
/giveaway draw
```

Expected:
- Ephemeral: `Winner posted in #<chan>: <@N> with X tickets.`
- Public embed `Winner — June 2026`:
  - "Prize: **Test Prize - Ole's Verification**"
  - "Winner: <@N>"
  - "Tickets: **X** of <total>"
  - "Entries: 2"
  - "**Top 5:**" with both entrants ranked by tickets

DB check: `giveaways.status = 'drawn'`, `winner_user_id` populated, `drawn_at` set.

### Step 13 — Re-run draw (idempotency check)

```
/giveaway draw
```

Expected ephemeral (red): "Already drawn; winner: <@N>."

### Step 14 — Start a new giveaway (lifecycle reset check)

```
/giveaway start prize:"Second Test" channel:#<that channel>
```

Expected: success. New entry embed posted. Previous drawn giveaway doesn't block.

### Step 15 — Cancel it

```
/giveaway cancel
```

Expected:
- Ephemeral: `Giveaway #M cancelled.`
- The entry embed message for "Second Test" is deleted from the channel.

DB check: `giveaways.status = 'cancelled'` for the second one.

## Cleanup

- Optional: delete the test giveaway rows manually if you don't want them lingering in stats:
  ```sql
  DELETE FROM giveaways WHERE prize LIKE 'Test Prize%' OR prize = 'Second Test';
  -- entries and votes cascade-delete
  ```

## If something fails

- Pull logs immediately: `docker logs --tail 100 royal-secretary-bot-prod`
- Note which step failed, what the actual vs expected output was, and ping me — most issues will be either a missing Steam link, a permission gap (bot missing channel access), or a config drift (`config.prospects.memberRoleId` is the role we gate voting on).
