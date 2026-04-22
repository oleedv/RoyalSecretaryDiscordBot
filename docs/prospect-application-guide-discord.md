# Prospect Application - Discord-Ready Version

Copy-paste each block below as a separate Discord message. Each is under the 2000-character limit. Tables have been replaced with Discord-friendly formatting.

---

## MESSAGE 1 - Intro + Cheat Sheet

```
# Prospect Application - Mentor Guide

A plain-language walkthrough of how the prospect application system works. Read the cheat sheet first; come back for the full walkthrough when you hit something unfamiliar.

## Cheat Sheet

**Lifecycle in one line:**
Apply -> Claim -> Pre-interview checks -> Sofa chat -> Accept -> Prospect Period (28 days) -> Vote -> Member or Denied

**Requirements we hold prospects to:**
- 18+
- Not dual-clanning (exceptions only when the other clan has no Squad server - contact management)
- Discord and in-game name must match
- 16 hours on our server across the 28-day period, in Discord VC while playing
- Follow RB Discord and server rules at all times

**Vote pass rule:**
- At least **10 yes votes**, AND
- At least **80% yes ratio** (yes / (yes + no))
- Unsure votes are shown but do NOT count toward the ratio

**Text commands (type in the prospect's channel):**
- `!reply <message>` - sends your message (and any attachments) to the prospect's DMs
- `!close` - closes the prospect channel immediately

**If something goes wrong:**
- Prospect left the server -> channel stays open, staff review
- Mentor left the server -> their prospects auto-unclaim, someone else claims
- Under 16h playtime at vote time -> vote pauses until 16h reached, or click **Force Vote**
- Ticket older than 48 hours and still unclaimed -> any mentor can grab it
```

---

## MESSAGE 2 - Button Reference

```
## Buttons You'll See

**Join RB** - opens the application form (on the public panel, clicked by the applicant)

**Continue Application** - opens part 2 of the form (clicked by the applicant)

**Claim** (blue) - assigns you as mentor, starts DM relay (new application, no mentor yet)

**Unclaim** (gray) - removes you as mentor (only the claiming mentor)

**Accepted** (green) - starts the 28-day prospect period (after sofa chat + all checks pass)

**Denied** (red) - rejects the application (visible at every stage)

**Invite to Voice** - DMs the prospect a voice channel link (after claim)

**Extend** - adds days to the prospect period (after acceptance)

**Force Vote** - manually starts voting early (after acceptance)

**Close Ticket** - deletes the channel (after denial or closure)

**Yes (N) / No (N) / Unsure (N)** - cast your vote (in the forum thread during voting, whitelisted staff only)
```

---

## MESSAGE 3 - What the Applicant Sees

```
## A. What the Applicant Experiences

Before you see anything, here's what the applicant goes through:

1. They click **Join RB** on the public panel.
2. A form `Join Royal Battalion (1/2)` opens asking for:
   - Alias / in-game name
   - Country
   - Date of birth (DD-MM-YYYY)
   - Hours in Squad
   - Preferred roles
3. They see a confirmation embed `Application Part 1 - Received` with a **Continue Application** button.
4. They fill in `Join Royal Battalion (2/2)`:
   - Previous clan (or "No")
   - Why they want to join RB (min 10 chars)
   - Active hours (UTC)
   - Competitive play (Yes / No / Unsure)
   - Steam ID (Steam64 number or full profile URL)
5. They get a DM titled `Application Received`.

> Part 1 data is remembered for only 15 minutes. If they wait too long before submitting part 2, they have to start over.
```

---

## MESSAGE 4 - Application Arrives + Claim

```
## B. The Application Arrives

As soon as they submit part 2:
- A private channel is created in the Prospect category: `prospect-alias-abc123`
- The **Mentor** role is pinged
- An embed **Prospect Application** is posted with all form answers plus quick links to steamid.com, BattleMetrics, and the Community Ban List
- Auto-loaded info follows within seconds:
  - Game Activity (90d): playtime, sessions, connections
  - Seeding (30d): hours, days, quality rating
  - Discord Activity (90d): voice time, messages, reactions
  - Community Ban List: risk rating, reputation points
  - BattleMetrics: bans, flags, staff notes
  - Steam: VAC, game bans, economy bans
- A separate **AI Assessment** embed has three tabs: **Summary**, **Flags**, **Positives**

Two buttons appear: **Claim** (blue) and **Denied** (red).

## C. Claiming a Prospect

Clicking **Claim**:
1. Assigns you as mentor in the database
2. Starts **DM relay** - their DMs to the bot appear in this channel; you reply with `!reply`
3. Buttons update to: **Accepted**, **Denied**, **Unclaim**, **Invite to Voice**

The prospect gets a DM titled `Mentor Assigned`. Click **Unclaim** to step back - DM relay stops and the Claim button returns.
```

---

## MESSAGE 5 - Pre-Interview Checks

```
## D. Pre-Interview Checks

Before inviting the prospect to a voice chat, run through these checks. Post `Checked` in the ticket when done so other mentors know it's safe to move on to the sofa chat.

**Form completeness**
- All form fields filled in
- Confirm they are 18+ (from date of birth)
- Confirm they are not in another clan. Dual-clanning is not allowed. Only exception: the other clan has no Squad server - contact management before continuing.

**Identity / account**
- If the Steam ID is correct, the bot's embed will include a BattleMetrics RCON link. If it's missing or wrong, a senior mentor has to locate the correct Steam ID through admin tools and update the ticket.

**Cross-reference their Steam64 ID against:**
- The Prospect Blacklist (condensed)
- The Community Ban List (CBL)
- Their BattleMetrics history - look for inappropriate past names (server-admin view)

**VAC / game bans**
- VAC bans older than 1500 days can be ignored.
- Any other ban case (newer VAC, game ban, economy ban) must be raised with the prospect in voice chat. You as the mentor can decide whether they get in or not.

Only after all checks pass, comment `Checked` in the ticket and move on to the sofa chat.
```

---

## MESSAGE 6 - Sofa Chat

```
## E. The Sofa Chat

Invite the prospect to the mentor voice channel (use the **Invite to Voice** button). If they can't join voice they'll likely have to verify - coordinate with a senior mentor.

**Trainees:** if this is your first ticket, a Senior Mentor or Community Officer must be on the call with you.

**Coverage:** if neither of you can hop in VC soon, find a time that suits both, or hand the ticket off. Tickets older than 48 hours are fair game for any mentor to grab so prospects don't wait.

Once introductions are done, get straight to the requirements.

**Go over these requirements with them:**
- Their Discord and in-game name must match. If they don't match, ask them to change their server nickname.
- 4-week (28-day) prospect period.
- 16 hours in game on our server, while in a Discord VC during play.
- During voting (starts in week 3), they need **at least 10 yes votes and 80% positive feedback**.
- Uphold RB Discord and server rules at all times.

Short summary to repeat to them: "Names match, 4 weeks, 16 hours, be on Discord, positive feedback, follow the rules."

Briefly explain the **Community Ban List** - a partner-run tool we use to share information and protect community integrity.

If they agree to the requirements, click **Accepted** on the ticket (see Message 8). The bot gives them the `P |` Discord nickname prefix. They have to set the in-game prefix themselves: **Settings > General > Player name prefix > `P | `** (mind the space after the pipe).
```

---

## MESSAGE 7 - Discord Tour + Before They Go

```
## F. Discord Tour

Still in the voice call, walk them through Discord:

- Ask how familiar they are with Discord in general.
- Make sure they have **Show All Channels** enabled in server settings, and show them how to minimize channel categories.
- Show them how to mute the seed channel or unsubscribe from the Seeders ping.
- Make sure they know where the rules channel is.
- Explain the VCs (and VC creation). Public Battalion can get noisy; encourage them to hop into RB VCs in game and on Discord so people get to know them and can give feedback later.

Ask them to find the prospect hub forum and check out:
- **Expectations** - summary of this call
- **Meet the prospects** - so RB can get to know them
- **Going away?** - the channel to post in if they need an extension, pause, or cancel. 4 weeks is the standard, but we're flexible and understanding.

## G. Before They Go

- Mention **CCFN on Sundays**.
- Ask if they know what **seeding** is. If not, give a quick explanation and encourage it - seeding hours count toward their 16h, and they do NOT have to be on Discord while seeding.
- Let them know that if everything goes OK they get **whitelist in week 3**, which is also when voting starts.
- Remind them they can DM you directly, or ask in the prospect lounge, if they have questions.

If Public Battalion or another VC is active, drag the prospect in and introduce them to the people there. If VC is empty now, do it the next time you see them online. Then they're free to go.
```

---

## MESSAGE 8 - Accept + Weekly Check-ins

```
## H. Accepting - Starting the Prospect Period

Once the sofa chat is done and they've agreed to the requirements, click **Accepted**:
- Sends the prospect a DM titled `Interview Passed`
- Creates a forum thread (voting happens here later)
- Changes their nickname to `P | their name`
- Starts the **28-day prospect period**

The embed now shows **Period Ends** and **Vote Date**. New buttons:
- **Extend** - opens a modal asking how many days to add (1-365)
- **Force Vote** - manually starts voting early
- **Denied** - still works at any point

## I. Weekly Check-ins

Checking in on your prospect is a core part of mentoring.

**End of week 1:**
- Check their game + Discord activity. The application embed auto-refreshes, or run `/activity` on their Discord user for a fresh breakdown.
- Send them a friendly message - how's it going, any questions, how are the hours looking.

**Start of week 3:**
- Check their hours again. If they are well under the minimum and clearly not on track (e.g., under 5 hours), you can deny them now rather than let voting start.
- If hours look good, the automatic vote trigger will fire once they hit 16h, or you can click **Force Vote** to push it through.
- Message the prospect to let them know their progress and that they now have whitelist.
```

---

## MESSAGE 9 - Voting

```
## J. Voting

Voting starts two ways:
- **Automatically** 7 days before the period ends - but only if the prospect has at least **16 hours** playtime on our Squad server.
- **Manually** when staff click **Force Vote** (ignores the 16h threshold).

> If the auto-trigger fires but they're under 16h, you'll see an "Insufficient Playtime" warning. Voting will start when they reach 16h, or you can force it.

When voting starts, an embed `Vote - Alias` is posted in the prospect's forum thread with:
- How long voting is open
- Their gameplay hours, seeding hours, mentor
- Three buttons: **Yes (N)**, **No (N)**, **Unsure (N)** (counts update live)

Clicking **No** opens a form `Vote No - Reason` requiring at least 5 characters.

Whitelisted staff can vote (the whitelist role is granted when the vote opens).

**Pass rule:**
- At least 10 yes votes, AND
- At least 80% yes ratio where ratio = yes / (yes + no)

**Example:** 12 yes, 2 no, 3 unsure
- Count: 12 >= 10 -> pass
- Ratio: 12 / 14 = 85.7% -> pass
- Result: **Accepted** (unsure votes don't affect the ratio)
```

---

## MESSAGE 10 - Outcomes + Edge Cases

```
## K. What Happens When Voting Ends

**Vote passes:**
- Prospect gets a DM titled `Welcome to Royal Battalion`
- Nickname prefix changes from `P |` to `RB |`
- Prospect role removed; whitelist role stays
- Announcement posted in the public lounge channel
- Forum thread stays visible

**Vote fails (or Denied clicked at any stage):**
- Prospect gets a DM titled `Application Denied` with the staff reason
- Nickname prefix removed
- Prospect role removed
- Forum thread deleted
- Tell them the cooling-off period is **3 weeks** before they can apply again. After that they are welcome to reapply if they think they can meet the requirements.

Click **Close Ticket** to delete the channel once you're done reviewing.

## L. Edge Cases

- **Duplicate applications** - blocked automatically. They see "You already have an open prospect application."
- **Prospect leaves the server** - notice posted; application stays open for staff to decide.
- **Mentor leaves the server** - all their prospects auto-unclaim. Someone else needs to pick them up.
- **Unclaimed ticket >48h** - any mentor can grab it to avoid the prospect waiting.
- **Part 1 data expires** - if more than 15 minutes pass before submitting part 2, they have to start over.
- **Steam ID format** - 17-digit Steam64 number OR full profile URL, either works.
- **Extend vs. pause** - Extend adds a fixed number of days. Pausing (admin-handled) freezes the clock and adds lost time back when unpaused.
- **Force Vote needs acceptance first** - the button only appears after the prospect has been accepted into the prospect period.
```

---

## MESSAGE 11 - Glossary

```
## Glossary

**Prospect** - an applicant who has submitted the form. They remain a prospect until accepted as a full member or denied.

**Mentor** - the staff member who claimed the application and is the main point of contact.

**Prospect period** - the 28-day trial between acceptance and voting, during which the prospect is tracked in-game and on Discord.

**Vote threshold** - the minimum yes count (10) and yes ratio (80%) needed to pass.

**Sofa chat** - the voice-chat interview held in the mentor VC before acceptance.

**Forum thread** - a thread in the forum channel, created on acceptance, where voting takes place.

**DM relay** - the two-way bridge between the prospect's DMs with the bot and their private channel. Active only while a mentor is claimed.

**Whitelist** - the role that grants access to vote and to the in-game whitelist.

**CBL (Community Ban List)** - a partner-run ban-sharing tool we check during pre-interview review.

**Prospect Blacklist (condensed)** - RB's internal list of Steam IDs not to accept, cross-referenced during pre-interview checks.
```
