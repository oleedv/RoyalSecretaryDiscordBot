# Prospect Application - Staff Guide

A plain-language walkthrough of how the prospect application system works for Royal Battalion staff. Read the cheat sheet first; come back for the full walkthrough when you hit something unfamiliar.

---

## Cheat Sheet

### The lifecycle in one line

**Apply -> Claim -> Accept -> Prospect Period (28 days) -> Vote -> Member or Denied**

### Buttons you'll see

| Button | What it does | When it appears | Who clicks |
|---|---|---|---|
| **Join RB** | Opens the application form | On the public recruitment panel | The applicant |
| **Continue Application** | Opens part 2 of the form | After part 1 is submitted | The applicant |
| **Claim** | Assigns you as mentor, starts DM relay | New application, no mentor yet | Any staff |
| **Unclaim** | Removes you as mentor | After you've claimed | The claiming mentor |
| **Accepted** | Starts the 28-day prospect period | After a mentor has claimed | The mentor |
| **Denied** | Rejects the application (any stage) | Always visible | Any staff |
| **Invite to Voice** | DMs the prospect a voice channel link | After claim | Any staff |
| **Extend** | Adds days to the prospect period | After acceptance | Any staff |
| **Force Vote** | Manually starts voting early | After acceptance | Any staff |
| **Close Ticket** | Deletes the channel | After denial/closure | Any staff |
| **Yes (N)** / **No (N)** / **Unsure (N)** | Cast your vote | In the forum thread during voting | Whitelisted staff |

### Text commands (type in the prospect channel)

| Command | What it does |
|---|---|
| `!reply <message>` | Sends your message (and any attachments) to the prospect's DMs |
| `!close` | Closes the prospect channel immediately |

### Vote pass rule

A prospect is **accepted** when the vote ends with:

- **at least 10 yes votes**, AND
- **at least 80%** yes ratio, calculated as `yes / (yes + no)`

Unsure votes are counted and shown, but do **not** count toward the ratio.

### If something goes wrong

- **Prospect left the server** - you'll see a notice in their channel. The application stays open for staff review.
- **Mentor left the server** - all their open prospects are auto-unclaimed. Another mentor needs to claim.
- **Low playtime at vote time** - if a prospect has under 16 hours in Squad when their period ends, voting is paused until they reach 16h. Click **Force Vote** to override.

---

## Full Walkthrough

### A. What the applicant experiences

Before you see anything on your side, here's what the applicant goes through, so you understand what they're referring to when they ask questions:

1. They find the public recruitment panel and click the **Join RB** button.
2. A form titled `Join Royal Battalion (1/2)` opens. They fill in:
   - **Alias / In-game name**
   - **Country**
   - **Date of birth** (format DD-MM-YYYY)
   - **Hours in Squad**
   - **Preferred roles**
3. They see a confirmation embed `Application Part 1 - Received` with a **Continue Application** button.
4. They click it and fill in `Join Royal Battalion (2/2)`:
   - **Previous clan** (or "No")
   - **Why do you want to join RB?** (min 10 characters)
   - **Active hours (UTC)**
   - **Interested in competitive play?** (Yes / No / Unsure)
   - **Steam ID** (Steam64 number or full profile URL)
5. They get a DM titled `Application Received`.

> Note: Part 1 data is remembered for only **15 minutes**. If the applicant takes too long to submit part 2, they have to start over.

### B. The application arrives

The moment the applicant submits part 2:

- A private text channel is created in the Prospect category, named something like `prospect-alias-abc123`.
- The **Mentor** role is pinged.
- A big embed titled **Prospect Application** is posted, showing:
  - All the form answers
  - The applicant's Discord avatar as a thumbnail
  - Quick links to steamid.com, BattleMetrics, and the Community Ban List
- More info is auto-loaded into the embed over the next few seconds:
  - **Game Activity (90 days)** - playtime, connections, average session length
  - **Seeding (30 days)** - hours, days, quality rating
  - **Discord Activity (90 days)** - voice time, messages, top channels, reactions
  - **Community Ban List** - risk rating and reputation points
  - **BattleMetrics bans, flags, and staff notes**
  - **Steam bans** - VAC, game bans, economy bans
- A separate **AI Assessment** embed appears with three tabs:
  - **Summary** - overall evaluation
  - **Flags** - potential concerns
  - **Positives** - strengths

At this point you see two buttons under the application: **Claim** (blue) and **Denied** (red).

### C. Claiming a prospect (becoming their mentor)

Clicking **Claim** does three things:

1. Assigns you as the prospect's mentor in the database.
2. Starts the **DM relay**: any message the prospect sends the bot in DMs appears in this channel, and you can send messages back to them using `!reply`.
3. Updates the buttons. You'll now see **Accepted**, **Denied**, **Unclaim**, and **Invite to Voice**.

The prospect gets a DM titled `Mentor Assigned` letting them know they can now talk to staff through the bot.

If you change your mind, click **Unclaim** to step back. The DM relay stops and the Claim button returns for someone else.

### D. Interviewing the prospect

While you're the mentor, you have two ways to talk to them:

- **`!reply your message here`** - type this in the prospect's channel. The message (plus any files you attach to the same message) goes to their DMs, prefixed with your name. An embed is logged in the channel so other staff can see the conversation.
- **Invite to Voice** button - sends the prospect a DM with a link to the configured voice channel so you can talk live.

When the prospect sends a DM to the bot, it appears as an embed in their channel with their avatar and message. They get a check-mark reaction on their DM so they know it went through.

### E. Accepting - starting the prospect period

When the interview goes well, click **Accepted**. This:

- Sends the prospect a DM titled `Interview Passed`.
- Creates a forum thread for them (this is where voting will happen later).
- Changes their nickname to `P | their name` so they're easy to spot.
- Starts a **28-day prospect period**.

The embed now shows **Period Ends** and **Vote Date**, and the buttons change to:

- **Extend** - opens a modal asking how many days to add (1-365).
- **Force Vote** - manually starts voting early (see next section).
- **Denied** - you can still reject them at any point.

### F. Voting

Voting can start two ways:

- **Automatically**, 7 days before the period ends - but only if the prospect has at least **16 hours** of playtime on our Squad server.
- **Manually**, when staff click **Force Vote**. This ignores the 16-hour threshold.

> Note: If the auto-trigger fires but the prospect is under 16h, you'll see an "Insufficient Playtime" warning. The vote will start automatically once they hit 16h, or you can click **Force Vote** to push it through anyway.

When voting starts, an embed titled `Vote - Alias` is posted in the prospect's forum thread. It shows:

- How long voting is open for
- The prospect's gameplay hours, seeding hours, and mentor
- Three buttons: **Yes (N)**, **No (N)**, **Unsure (N)** (the counts update live)

Clicking **No** opens a small form titled `Vote No - Reason` asking why. You need to give at least 5 characters. The reason is saved for review.

**Who can vote:** whitelisted staff members (the whitelist role is granted when the vote opens).

**Pass rule, stated plainly:**

- **At least 10 yes votes, AND**
- **At least 80% yes ratio**, where ratio = `yes / (yes + no)`

**Example:** 12 yes, 2 no, 3 unsure

- Count check: 12 >= 10, pass
- Ratio: 12 / (12 + 2) = 85.7%, which is >= 80%, pass
- Result: **Accepted**

The 3 unsure votes are recorded but don't affect the ratio.

### G. What happens when voting ends

**If the vote passes:**

- The prospect gets a DM titled `Welcome to Royal Battalion`.
- Their nickname prefix changes from `P |` to `RB |`.
- The prospect role is removed; the whitelist role stays.
- An announcement is posted in the public lounge channel.
- The forum thread stays visible.

**If the vote fails (or a staff member clicks Denied at any stage):**

- The prospect gets a DM titled `Application Denied` with the reason staff provided.
- Their nickname prefix is removed.
- The prospect role is removed.
- The forum thread is deleted.

After either outcome, you can click **Close Ticket** to delete the prospect channel once you're done reviewing it.

### H. Edge cases (these catch people out)

- **Duplicate applications** - the bot blocks them automatically. An applicant who already has an open prospect cannot start a new one and will see the message "You already have an open prospect application."
- **Prospect leaves the server partway through** - you'll see a notice saying they left, but the application stays open. It's up to staff to decide whether to deny or keep it open in case they rejoin.
- **Mentor leaves the server** - all their claimed prospects are automatically unclaimed. Prospects get a notice that DM relay is no longer active. Another mentor needs to pick them up.
- **Part 1 data expires** - if an applicant finishes part 1 but waits more than 15 minutes before submitting part 2, their part 1 answers are wiped. They'll see "Your Part 1 data has expired. Please start over by clicking Join RB again."
- **Steam ID format** - the bot accepts either a 17-digit Steam64 number or a full Steam profile URL. Both work.
- **Extend vs. pause** - **Extend** adds a fixed number of days to the period. Pausing (handled separately by admins) freezes the clock; when unpaused, the lost time is added back.
- **Force Vote requires acceptance first** - you can only force a vote after the prospect has been accepted into the prospect period. Before that, the button isn't shown.

### I. Glossary

- **Prospect** - an applicant who has submitted the form. They remain a prospect until accepted as a full member or denied.
- **Mentor** - the staff member who claimed the application and is the main point of contact.
- **Prospect period** - the 28-day trial period between acceptance and voting, during which the prospect is tracked in-game and on Discord.
- **Vote threshold** - the minimum yes count (10) and yes ratio (80%) needed to pass.
- **Forum thread** - a thread in the forum channel, created on acceptance, where voting takes place.
- **DM relay** - the two-way bridge between the prospect's DMs with the bot and their private channel. Active only while a mentor is claimed.
- **Whitelist** - the role that grants access to vote and to the in-game whitelist.
