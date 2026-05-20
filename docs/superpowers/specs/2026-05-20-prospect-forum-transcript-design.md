# Prospect forum-thread transcript

## Goal

Capture every message posted to a prospect's public forum thread (the discussion + vote thread created on prospect acceptance), store it in MariaDB, and render it on the existing public web transcript at `<webBaseUrl>/prospect/<uuid>`.

Today the staff-side DM relay is persisted to `prospect_messages` and shown on the website. The forum thread — where clan members discuss applicants and where the vote embed is posted — is never recorded. The thread is **deleted** when the prospect closes (`prospectService.js`'s `closeProspect`), so anything not captured during the open period is lost permanently.

## Scope

In scope:

- New table `prospect_forum_messages` to store one row per forum-thread message.
- Live capture: every new message in a thread under the prospects forum channel is persisted to the new table.
- Final-flush on close: pull the full thread message history into the DB immediately before the existing `thread.delete()` call.
- One-shot owner-only slash command `/backfill-prospect-forums` to seed history for prospects already open at deploy time.
- Public web display: new "Forum Discussion" section on `/prospect/<uuid>`, rendered between **Votes** and **Timeline**.
- Capture bot messages (intro embed, vote embed) verbatim and render their embeds inline on the web page.

Out of scope:

- Edits, deletes, reactions, and pins on forum messages. v1 is a transcript snapshot — last-write-wins is not implemented; once a message is captured, edits are not reflected.
- Access gating. The transcript is exposed under the same conditions as the rest of `/prospect/<uuid>` — public by UUID, no auth.
- Mention resolution (e.g. turning `<@123>` into a name). Stored verbatim; the website can resolve later if desired.
- A new API route. The existing `GET /tickets/by-uuid/prospect/:uuid` is extended.

## Design

### Storage

```sql
CREATE TABLE IF NOT EXISTS prospect_forum_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  prospect_id INT NOT NULL,
  message_id VARCHAR(20) NOT NULL UNIQUE,
  author_id VARCHAR(20) NOT NULL,
  author_tag VARCHAR(100) NOT NULL,
  author_avatar VARCHAR(255) NULL,
  is_bot TINYINT(1) DEFAULT 0,
  content TEXT,
  attachments JSON,
  embeds JSON,
  created_at TIMESTAMP NOT NULL,
  FOREIGN KEY (prospect_id) REFERENCES prospects(id),
  INDEX idx_pfm_prospect_created (prospect_id, created_at)
);
```

Key choices:

- **Separate table from `prospect_messages`.** Forum content has a different shape (bot embeds; no DM-relay `is_staff` concept), and mixing the streams in one table forces nullable columns and source-discriminators that would have to be checked on every read.
- **`message_id UNIQUE`** lets live capture, final-flush, and `/backfill-prospect-forums` all use `INSERT IGNORE` safely — re-runs and overlaps are no-ops.
- **`created_at` from the Discord message timestamp, not `NOW()`.** Backfilled history and out-of-order arrivals stay correctly ordered.
- **`embeds JSON`** stores the raw discord.js `Embed#toJSON()` shape so the website renders the bot's intro / vote embeds without us inventing an intermediate schema.

Migration goes in `src/database/schema.js` alongside the other prospect tables, using the same `CREATE TABLE IF NOT EXISTS` pattern.

### Bot capture pipeline

#### Service additions (`src/services/prospect/prospectService.js`)

```js
export async function saveForumMessage(prospectId, message) { /* INSERT IGNORE one row */ }
export async function backfillForumThread(prospect, thread) { /* paginate + bulk INSERT IGNORE */ }
```

Row builder maps a discord.js `Message` to the table columns:

- `message_id` → `message.id`
- `author_id` → `message.author.id`
- `author_tag` → `message.author.tag`
- `author_avatar` → `message.author.displayAvatarURL()` (or null)
- `is_bot` → `message.author.bot ? 1 : 0`
- `content` → `message.content`
- `attachments` → existing `formatForDb(message.attachments)` helper
- `embeds` → `JSON.stringify(message.embeds.map((e) => e.toJSON()))`
- `created_at` → `message.createdAt`

`backfillForumThread` paginates `thread.messages.fetch({ limit: 100, before })` until empty. Builds a list of values, then issues a single multi-row `INSERT IGNORE` per batch. Returns `{ inserted, skipped }` counts.

#### Live capture (`src/handlers/prospectForumMessages.js`, new)

Exports `handleForumThread(message)`:

1. Look up `prospect_id` via `forum_thread_id = message.channel.id`. If no match, return.
2. Call `saveForumMessage(prospect.id, message)`.

#### Routing change (`src/events/messageCreate.js`)

Today's flow in `messageCreate`:

```js
if (message.author.bot) return;   // line 26 — skips bot messages globally
...
async function handleGuild(message) {
  const parentId = message.channel.parentId;
  ...
  const relevantCategories = [config.ticket?.categoryId, config.prospect?.categoryId].filter(Boolean);
  if (relevantCategories.length > 0 && !relevantCategories.includes(parentId)) return;
  ...
}
```

Two adjustments:

1. **Forum thread routing must run before the bot-author short-circuit**, so the bot's own intro/vote embeds are captured. Restructure so:
   - In `execute`, after the partial-fetch but before `if (message.author.bot) return`, check if `message.guild` and `message.channel.isThread()` and the thread's parent equals `config.prospects.forumChannelId`. If so, route to `prospectForumMessages.handleForumThread(message)` and return.
   - Logging (`logMessage`, `incrementMessageCount`) stays gated on `!message.author.bot` as today.
2. The forum branch is independent of the existing `relevantCategories` filter — forum threads' `parentId` is the forum channel, not a category — so no change needed there.

#### Final flush on close (`prospectService.js`'s `closeProspect`, around the existing `thread.delete()` call)

Currently:

```js
if (thread) {
  await thread.delete(`Prospect ${outcome}`).catch(...);
}
```

Change to:

```js
if (thread) {
  await backfillForumThread(prospect, thread).catch((err) =>
    log.warn({ err, prospectId: prospect.id }, 'Final forum flush failed; proceeding with delete')
  );
  await thread.delete(`Prospect ${outcome}`).catch(...);
}
```

The flush is best-effort: if it fails, we still delete (current behavior). Live capture should have already recorded most messages anyway.

#### Backfill command (`src/commands/backfill-prospect-forums.js`, new)

- Owner-only (same `OWNER_ID` guard pattern as `refresh-panels.js`).
- Slash command `/backfill-prospect-forums`, default member permission `Administrator`.
- Defers an ephemeral reply.
- Selects `SELECT id, uuid, forum_thread_id FROM prospects WHERE status = 'open' AND forum_thread_id IS NOT NULL`.
- For each prospect:
  1. Fetch the forum channel and the thread. Skip silently on miss with outcome `skipped:no-thread`.
  2. Call `backfillForumThread(prospect, thread)`. Record `inserted` and `skipped`.
- Wrap each iteration in try/catch so one bad prospect doesn't abort the loop.
- Reply with an ephemeral summary similar to `refresh-panels` (per-prospect line: alias + counts or error).

Idempotency: `INSERT IGNORE` on `message_id` means re-running is safe and reports the dup count as `skipped`.

### Webpage API

Extend `GET /tickets/by-uuid/prospect/:uuid` in `packages/api/src/routes/tickets.ts`. The handler already runs three sub-queries (events, messages, votes); add a fourth:

```ts
const forumMessageRows: any[] = await getSecretaryDb().$queryRaw(Prisma.sql`
  SELECT id, prospect_id, message_id, author_id, author_tag, author_avatar,
         is_bot, content, attachments, embeds, created_at
    FROM prospect_forum_messages
   WHERE prospect_id = ${id}
   ORDER BY created_at ASC`);
```

Map into a new `forumMessages` array on the response. Each entry:

```ts
{
  id: number;
  prospectId: number;
  messageId: string;
  authorId: string;
  authorTag: string;
  authorAvatar: string | null;
  isBot: boolean;
  content: string | null;
  attachments: string | null;            // raw JSON string; existing parseAttachments handles it
  embeds: unknown[] | null;              // parsed JSON; null if column is null
  createdAt: string;                     // ISO
}
```

Update the shared `Prospect` type in `packages/shared/types/tickets.ts` to include `forumMessages?: ProspectForumMessage[]` and export `ProspectForumMessage`.

No new route, no new permission check.

### Website display

In `packages/web/app/(public)/prospect/[uuid]/page.tsx`, add a new section between the existing **Votes** block (lines 250-270) and **Events timeline** (lines 273-298), titled **Forum Discussion**.

Each message renders as a **chat bubble** (avatar, author tag, timestamp, content via existing `Linkify`, attachments via existing `MessageAttachments`). If the message also carries embeds, render them below the bubble's content via a new `<ProspectForumEmbed embed={...} />` component — a discord-style card: left color stripe from `embed.color`, optional author row, title, description, fields grid, image/thumbnail, footer.

For bot messages the bubble's text body is typically empty and the embed card carries the content (intro embed, vote embed). For member messages it's the opposite. The same render path handles both naturally — empty content collapses, missing embeds skip.

Styling consistent with the existing page: `facet-border rounded-sm bg-bg-card p-5`, neutral border for member bubbles, accent stripe for bot embed cards (color from the embed itself).

Empty state: `"No forum discussion recorded."`

Ordering: strictly chronological by `created_at`. The bot's intro embed appears first, the vote embed appears at the moment voting started, member chatter is interleaved naturally.

## Testing

Manual:

- Staging: open a new prospect application; verify the staff embed and forum thread create normally. Post a message in the thread as a clan member; reload `/prospect/<uuid>`; verify the message appears under "Forum Discussion."
- In the same prospect, verify the bot's intro embed and (after vote starts) the vote embed both render as embed cards in chronological position.
- Close the prospect (accept or deny). Re-fetch the page; verify all messages are still present (final flush captured anything live capture missed) even though the thread is now gone from Discord.
- Run `/backfill-prospect-forums` on an existing open prospect that had no messages stored. Verify the summary reports `inserted > 0` and the page shows the historical messages.
- Re-run `/backfill-prospect-forums` immediately. Verify the summary now reports the same count as `skipped` (dedupe via `message_id UNIQUE`) and the page is unchanged.
- Unset `config.webBaseUrl` — irrelevant for this feature, but confirm nothing crashes elsewhere.

## Risks

- **Rate limits during backfill**: a thread with hundreds of messages produces many fetch calls. discord.js handles the bucket internally; for active prospects this is bounded by the period length (typically <50 messages per thread). Log progress every batch.
- **Bot-message routing change**: moving the forum-thread branch above the global `if (message.author.bot) return` could in principle let a bug elsewhere process bot messages it shouldn't. Mitigation: the forum branch is the only one above that check, and it returns immediately.
- **`embeds` column size**: discord.js embed JSON can be ~5KB per embed. `JSON` column is plenty large, but the row stays well under the InnoDB 65KB inline limit even with multiple embeds.
- **Avatar URL rot**: Discord avatar URLs use a versioned hash and can change. We snapshot the URL at capture time; broken images on the page after a long delay are a known and acceptable limitation. Could be revisited if it becomes annoying.
- **Privacy**: forum discussion includes clan member names and opinions, exposed at a public UUID link. The user has explicitly confirmed this exposure level. If that changes later, gating belongs at the API route level, not in capture.
