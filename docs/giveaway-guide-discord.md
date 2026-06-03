# Monthly Giveaway — Staff Guide

This is the runbook for running a monthly RB game giveaway through the bot. Aimed at the person actually clicking the buttons (Onion, or any staff member with `Manage Server`).

## The short version

Each month you do this:

1. **Start of the month:** `/giveaway start prize:<game> channel:#giveaways`
2. **People click "Enter Giveaway"** through the month. Hours played and hours seeded automatically determine their ticket count.
3. **A few days before draw day:** `/giveaway open-vote channel:#rb-only-channel`
4. **RB members vote** for who went above and beyond. Each vote = +1 extra ticket.
5. **End of month:** `/giveaway draw`. Bot picks a winner weighted by ticket count and posts the result.

That's the whole loop.

## How tickets are earned

- **1 ticket per hour played** on RB main/battle in the last 30 days
- **+2 tickets per hour seeded** in the last 30 days
- **+1 ticket per community vote** (RB members only, max 2 votes per voter)
- **Minimum 5 hours played** to be eligible at all

Manual entries (for community members without a linked Steam account) use the hours you give them when adding the entry.

## The commands

You'll need the `Manage Server` permission for all of these.

### `/giveaway start prize:<text> channel:#<chan>`

Posts the entry message. People click "Enter Giveaway" to opt in.

- **prize:** Whatever the game is, e.g. `"Helldivers 2"`
- **channel:** Where the entry post goes. Pick somewhere public (e.g. `#giveaways` or `#royal-lounge`).

The bot rejects this if a giveaway is already active. Cancel or draw the existing one first.

### `/giveaway add-entry user:@<member> hours:<n> seed:<n>`

For community regulars without a linked Steam account — manually credit them with hours.

- **user:** The Discord user
- **hours:** Played hours to credit (your judgment)
- **seed:** Seed hours to credit

Re-running this on the same user updates their numbers instead of duplicating.

### `/giveaway leaderboard`

Shows current ticket totals for everyone entered. Ephemeral (only you see it). Useful for sanity-checking before the draw.

### `/giveaway open-vote [channel:#<chan>]`

Posts the community vote message — one button per entrant.

- **channel:** Optional. If omitted, it goes in the entry channel. **For now, point this to an RB-only channel** since only RB can vote. Once you have non-RB entries, you'll want the vote out of public view.

The bot rejects this if there are zero entries.

### `/giveaway draw`

Runs the weighted random pick and posts the winner embed. Idempotent — running it twice on the same giveaway just shows "already drawn".

### `/giveaway cancel`

Marks the active giveaway as cancelled and deletes the entry/vote messages. Use this if you mis-posted, picked the wrong prize, etc. There's no undo.

## What people see

**On the entry post:**
- Title `RB Member Game Giveaway — <Month> <Year>`
- Prize name, ticket rules, minimum hours, deadline, current entry count
- A blue **Enter Giveaway** button

**When they click Enter:**
- If linked Steam + 5h+ played: confirmation with their current ticket count
- If not linked: "Link your Steam first" — they need to use the verify panel before they can enter
- If under 5h: "You need 5h, you have X" — informs them they need more time on the server

**On the vote post:**
- One button per entrant
- They can vote for up to 2 different people (cannot vote twice for the same person, cannot vote for themselves)

**On the winner embed:**
- Winner mention, ticket count, total tickets, top-5 breakdown for transparency

## Common questions

**Q: Can I change the prize after starting?**
Not directly. Cancel and re-start. (If we end up doing this regularly I can add an `edit` subcommand.)

**Q: Can non-RB community members enter?**
Yes — but they need either a linked Steam (we don't have a self-serve linking flow for non-RB yet) OR you add them manually via `/giveaway add-entry`. The flow is built so it can open up to the wider community when self-serve linking ships, but for now treat it as RB-only with manual additions.

**Q: What if someone leaves the Discord between entering and the draw?**
They stay in the draw. If they win, the bot posts a mention — staff can DM them or post in `#royal-lounge`.

**Q: What if someone re-links their Steam mid-month?**
Their original Steam ID at entry-time is what's used for the draw. Fairness lock.

**Q: How are ties handled?**
There aren't really ties — it's a weighted random roll over total tickets, so even with equal tickets the bot picks one. Nothing to do.

**Q: Can I see entries before opening the vote?**
Yes — `/giveaway leaderboard` shows everyone with their computed tickets.

**Q: What if the bot is down at draw time?**
Just run `/giveaway draw` when it's back up. All state is in the database.

## When something goes wrong

If a command silently fails or replies with "Something went wrong", ping Ole. Include:
- Which step (`/giveaway start`, vote button click, etc.)
- What you saw vs. what you expected
- Roughly when it happened (so logs can be pulled)

For people complaining "I have hours but the bot says I have 0":
- 99% of the time their Steam isn't linked. Have them go through the verify panel first.
- If linked, check `/giveaway leaderboard` — if they don't show up, check whether they have ≥5h actual playtime in the last 30 days.

## What's coming later (Phase 2)

These aren't built yet — bring them up if/when you actually need them:

- **Self-serve linking for non-RB** so the community can enter without manual adds
- **Webpage view** of the leaderboard
- **Auto-draw** at month end (currently manual)
- **Multi-prize** draws (1st/2nd/3rd)
- **Community-wide vote** (currently RB-only)
