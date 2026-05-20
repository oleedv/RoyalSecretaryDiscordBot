# Prospect Forum-Thread Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture every message in a prospect's public forum discussion thread (including the bot's intro and vote embeds), store it in MariaDB, and render the transcript on the public web page at `/prospect/<uuid>`.

**Architecture:** Bot writes to a new `prospect_forum_messages` table from three paths — live `messageCreate` capture, a one-shot owner-only backfill command, and a final flush inside `closeProspect` immediately before the thread is deleted. The webpage's existing `GET /tickets/by-uuid/prospect/:uuid` endpoint is extended to return the new collection, and `/prospect/<uuid>` renders a new "Forum Discussion" section.

**Tech Stack:**
- Bot: Bun + discord.js v14 + MariaDB (raw `query()` helper), ESM modules
- Web API: Hono + Prisma raw SQL on the same MariaDB
- Web UI: Next.js 15 / React 19 / Tailwind v4 (client component, `"use client"`)

**Spec:** `docs/superpowers/specs/2026-05-20-prospect-forum-transcript-design.md`

**Test infrastructure:** Neither repo has automated tests today. Verification in this plan is manual against the staging environment (`stg.royalbattalion.xyz`) at the end of the work. Do not invent a new test framework as part of this plan — that is unsolicited scope.

**Working directories:**
- Bot repo: `C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot`
- Web repo: `C:/Users/OleEd/Azure/RoyalBattalionWebpage`

---

## File Inventory

**Bot repo (`RoyalSecretaryDiscordBot`):**

| Action | Path | Responsibility |
|---|---|---|
| Modify | `src/database/schema.js` | Add `CREATE TABLE prospect_forum_messages` block |
| Modify | `src/services/prospect/prospectService.js` | Add `saveForumMessage`, `backfillForumThread`; call flush in `closeProspect` before `thread.delete()` |
| Create | `src/handlers/prospectForumMessages.js` | `handleForumThread(message)` — look up prospect by `forum_thread_id`, save |
| Modify | `src/events/messageCreate.js` | Route forum-thread messages before the bot-author short-circuit |
| Create | `src/commands/backfill-prospect-forums.js` | Owner-only slash command for one-shot history backfill |

**Web repo (`RoyalBattalionWebpage`):**

| Action | Path | Responsibility |
|---|---|---|
| Modify | `packages/shared/types/tickets.ts` | Add `ProspectForumMessage` interface; add `forumMessages?:` to `Prospect` |
| Modify | `packages/api/src/routes/tickets.ts` | Extend `GET /tickets/by-uuid/prospect/:uuid` with new query + mapping |
| Create | `packages/web/app/(public)/prospect/[uuid]/ProspectForumEmbed.tsx` | Render one Discord embed as a card |
| Modify | `packages/web/app/(public)/prospect/[uuid]/page.tsx` | Render "Forum Discussion" section using existing helpers + new component |

---

## Task 1: Schema migration for `prospect_forum_messages`

**Files:**
- Modify: `C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot/src/database/schema.js`

- [ ] **Step 1: Add the `CREATE TABLE` block**

Open `src/database/schema.js` and locate the existing `prospect_votes` block (currently around line 162-173). Insert this new block immediately after the `prospect_votes` `CREATE TABLE`:

```js
  await query(`
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
    )
  `);
```

- [ ] **Step 2: Start the bot once locally to apply the migration**

Run:
```
bun run start
```
Expected: boot log line `Initializing database schema...` followed by normal boot. Stop the bot after it logs `[boot] bot environment`.

- [ ] **Step 3: Verify the table exists**

Connect to the dev MariaDB and run:
```sql
DESCRIBE prospect_forum_messages;
```
Expected: 11 rows, the `message_id` column shows `UNI` in the `Key` column.

- [ ] **Step 4: Commit**

```
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot add src/database/schema.js
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot commit -m "feat(prospects): add prospect_forum_messages table for forum transcript capture"
```

---

## Task 2: `saveForumMessage` and `backfillForumThread` service functions

**Files:**
- Modify: `C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot/src/services/prospect/prospectService.js`

These are the two service-layer entry points the handlers will call. Both must be safe to call repeatedly on the same Discord message (idempotent via `INSERT IGNORE` on `message_id UNIQUE`).

- [ ] **Step 1: Add a row-builder helper and the two exports**

Open `src/services/prospect/prospectService.js`. Locate `saveProspectMessage` (currently around line 486). Add the following code immediately after that function:

```js
function buildForumMessageRow(prospectId, message) {
  const attachments = Array.from(message.attachments.values()).map((a) => ({
    url: a.url,
    name: a.name,
    contentType: a.contentType,
  }));
  const embeds = message.embeds.map((e) => e.toJSON());
  return [
    prospectId,
    message.id,
    message.author.id,
    message.author.tag,
    message.author.displayAvatarURL?.() || null,
    message.author.bot ? 1 : 0,
    message.content || null,
    JSON.stringify(attachments),
    JSON.stringify(embeds),
    message.createdAt,
  ];
}

export async function saveForumMessage(prospectId, message) {
  const row = buildForumMessageRow(prospectId, message);
  await query(
    `INSERT IGNORE INTO prospect_forum_messages
       (prospect_id, message_id, author_id, author_tag, author_avatar,
        is_bot, content, attachments, embeds, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row
  );
}

export async function backfillForumThread(prospectId, thread) {
  let before = undefined;
  let inserted = 0;
  let scanned = 0;
  while (true) {
    const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;

    for (const message of batch.values()) {
      const row = buildForumMessageRow(prospectId, message);
      const result = await query(
        `INSERT IGNORE INTO prospect_forum_messages
           (prospect_id, message_id, author_id, author_tag, author_avatar,
            is_bot, content, attachments, embeds, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row
      );
      scanned++;
      if (result.affectedRows > 0) inserted++;
    }

    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return { inserted, scanned, skipped: scanned - inserted };
}
```

Notes:
- `displayAvatarURL?.()` — partial-fetched `Message` partials may have an incomplete `author`; the optional chain prevents a crash and stores `null`.
- `result.affectedRows` from `INSERT IGNORE` is `0` on duplicate, `1` on insert (MariaDB behavior).
- Pagination uses `before = batch.last().id` because `messages.fetch` returns newest-first.
- We stop early when a batch returns fewer than 100 messages — the last page.

- [ ] **Step 2: Sanity-check the build**

Run from the bot repo:
```
bun run --silent -e "import('./src/services/prospect/prospectService.js').then(m => console.log(typeof m.saveForumMessage, typeof m.backfillForumThread))"
```
Expected: `function function`

- [ ] **Step 3: Commit**

```
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot add src/services/prospect/prospectService.js
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot commit -m "feat(prospects): add saveForumMessage and backfillForumThread services"
```

---

## Task 3: Live-capture handler

**Files:**
- Create: `C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot/src/handlers/prospectForumMessages.js`

The handler is intentionally tiny: look up the prospect by thread id, then save. All filtering happens upstream in the router.

- [ ] **Step 1: Add a lookup helper to `prospectService.js`**

The service already has lookups by channel/user but none keyed on `forum_thread_id`. Add this near the other accessors in `src/services/prospect/prospectService.js` (find the block with `getProspectByChannelAnyStatus` and put it adjacent):

```js
export async function getProspectByForumThread(forumThreadId) {
  const rows = await query(
    `SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE forum_thread_id = ?`,
    [forumThreadId]
  );
  return rows[0] || null;
}
```

`PROSPECT_COLUMNS` is the existing column list at the top of the file (around line 33). No changes needed there.

- [ ] **Step 2: Create the handler**

Create `src/handlers/prospectForumMessages.js` with:

```js
import { getProspectByForumThread, saveForumMessage } from '../services/prospect/prospectService.js';
import logger from '../logger.js';

const log = logger.child({ module: 'prospectForumMessages' });

export async function handleForumThread(message) {
  const prospect = await getProspectByForumThread(message.channel.id);
  if (!prospect) return false;

  await saveForumMessage(prospect.id, message);
  log.debug({ prospectId: prospect.id, messageId: message.id, isBot: message.author.bot }, 'Forum message saved');
  return true;
}
```

Returning `true`/`false` mirrors the convention used by the existing `ticketMessages.handleGuild` / `prospectMessages.handleGuild` so the router can short-circuit on a hit.

- [ ] **Step 3: Commit**

```
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot add src/services/prospect/prospectService.js src/handlers/prospectForumMessages.js
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot commit -m "feat(prospects): add forum-thread message handler and lookup"
```

---

## Task 4: Route forum-thread messages in `messageCreate`

**Files:**
- Modify: `C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot/src/events/messageCreate.js`

The current `messageCreate` does `if (message.author.bot) return;` at the top (line 26). Bot messages are intentionally skipped everywhere else; we must route forum messages *before* this short-circuit so the bot's intro and vote embeds get captured. The forum branch is the only path that bypasses the bot check.

- [ ] **Step 1: Add the import**

In `src/events/messageCreate.js`, add to the imports block at the top:

```js
import * as prospectForumMessages from '../handlers/prospectForumMessages.js';
import config from '../config.js';
```

(`config` is already imported — verify; if so, only add the `prospectForumMessages` line. The current file at line 11 already imports `config`.)

- [ ] **Step 2: Insert the forum-thread branch before the bot-author check**

Locate the `execute` function (currently starts around line 19). The current flow is:

```js
async execute(message) {
  if (message.partial) {
    try { message = await message.fetch(); } catch (err) {
      log.error({ err }, 'messageCreate: failed to fetch partial');
      return;
    }
  }
  if (message.author.bot) return;

  logMessage(message);
  if (message.guild) incrementMessageCount(message.author.id, message.channel.id, message.channel.name);
  ...
}
```

Change it to insert a forum-thread branch between the partial-fetch and the bot short-circuit:

```js
async execute(message) {
  if (message.partial) {
    try { message = await message.fetch(); } catch (err) {
      log.error({ err }, 'messageCreate: failed to fetch partial');
      return;
    }
  }

  // Forum-thread capture runs BEFORE the bot-author short-circuit so bot intro/vote embeds are saved.
  if (
    message.guild &&
    message.channel.isThread?.() &&
    config.prospects?.forumChannelId &&
    message.channel.parentId === config.prospects.forumChannelId
  ) {
    try {
      await prospectForumMessages.handleForumThread(message);
    } catch (err) {
      reportError(err, {
        source: 'messageCreate.forumThread',
        userId: message.author?.id,
        channelId: message.channel?.id,
      }).catch(() => {});
    }
    return;
  }

  if (message.author.bot) return;

  logMessage(message);
  if (message.guild) incrementMessageCount(message.author.id, message.channel.id, message.channel.name);
  ...
}
```

Rationale for the early `return`: a forum-thread message will never match the ticket/prospect category routing further down, and we don't want it counted in activity stats or DM logs (its channel isn't a regular guild text channel).

- [ ] **Step 3: Smoke test the bot boots**

Run:
```
bun run start
```
Expected: clean boot, single `[boot] bot environment` line as usual. Stop the bot.

- [ ] **Step 4: Commit**

```
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot add src/events/messageCreate.js
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot commit -m "feat(prospects): route forum-thread messages to capture handler before bot short-circuit"
```

---

## Task 5: Final-flush on prospect close

**Files:**
- Modify: `C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot/src/services/prospect/prospectService.js`

The current `closeProspect` deletes the forum thread (currently around line 818). Insert a backfill call immediately before the delete so anything live capture missed is recorded permanently.

- [ ] **Step 1: Patch `closeProspect`**

Find this block (around lines 815-822):

```js
    if (forumChannel) {
      const thread = await forumChannel.threads.fetch(prospect.forum_thread_id).catch(() => null);
      if (thread) {
        await thread.delete(`Prospect ${outcome}`).catch((err) =>
          log.warn({ err, threadId: prospect.forum_thread_id }, 'Failed to delete forum thread')
        );
      }
    }
```

Replace it with:

```js
    if (forumChannel) {
      const thread = await forumChannel.threads.fetch(prospect.forum_thread_id).catch(() => null);
      if (thread) {
        try {
          const flushResult = await backfillForumThread(prospect.id, thread);
          log.info({ prospectId: prospect.id, ...flushResult }, 'Final forum flush before delete');
        } catch (err) {
          log.warn({ err, prospectId: prospect.id }, 'Final forum flush failed; proceeding with delete');
        }
        await thread.delete(`Prospect ${outcome}`).catch((err) =>
          log.warn({ err, threadId: prospect.forum_thread_id }, 'Failed to delete forum thread')
        );
      }
    }
```

`backfillForumThread` is already exported from this same file (Task 2), so no import is needed.

- [ ] **Step 2: Commit**

```
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot add src/services/prospect/prospectService.js
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot commit -m "feat(prospects): flush forum thread to DB before deleting on close"
```

---

## Task 6: `/backfill-prospect-forums` owner command

**Files:**
- Create: `C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot/src/commands/backfill-prospect-forums.js`

Owner-only command following the same pattern as `src/commands/refresh-panels.js`. Iterates open prospects with a forum thread and pulls full history.

- [ ] **Step 1: Create the command file**

Create `src/commands/backfill-prospect-forums.js`:

```js
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { query } from '../database/connection.js';
import { backfillForumThread } from '../services/prospect/prospectService.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:backfill-prospect-forums' });
const OWNER_ID = '195412349153312768';

export default {
  data: new SlashCommandBuilder()
    .setName('backfill-prospect-forums')
    .setDescription('One-shot: pull forum-thread history into the DB for open prospects')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ embeds: [errorEmbed('This command is restricted.')], flags: ['Ephemeral'] });
    }

    await interaction.deferReply({ flags: ['Ephemeral'] });

    const forumChannelId = config.prospects?.forumChannelId;
    if (!forumChannelId) {
      return interaction.editReply({ embeds: [errorEmbed('No forum channel configured.')] });
    }

    const forumChannel = await interaction.guild.channels.fetch(forumChannelId).catch(() => null);
    if (!forumChannel) {
      return interaction.editReply({ embeds: [errorEmbed('Forum channel not found.')] });
    }

    const rows = await query(
      `SELECT id, uuid, alias, forum_thread_id
         FROM prospects
        WHERE status = 'open' AND forum_thread_id IS NOT NULL`
    );

    if (rows.length === 0) {
      return interaction.editReply({ embeds: [successEmbed('No open prospects with forum threads.')] });
    }

    const results = [];
    for (const p of rows) {
      try {
        const thread = await forumChannel.threads.fetch(p.forum_thread_id).catch(() => null);
        if (!thread) {
          results.push(`- **${p.alias}**: skipped (thread not found)`);
          continue;
        }
        const { inserted, scanned } = await backfillForumThread(p.id, thread);
        results.push(`- **${p.alias}**: ${inserted} new / ${scanned} scanned`);
        log.info({ prospectId: p.id, inserted, scanned }, 'Forum backfill completed');
      } catch (err) {
        log.error({ err, prospectId: p.id }, 'Forum backfill failed');
        results.push(`- **${p.alias}**: error (${err.message})`);
      }
    }

    await interaction.editReply({ embeds: [successEmbed(results.join('\n'))] });
  },
};
```

- [ ] **Step 2: Deploy slash commands and verify registration**

Run:
```
bun run deploy-commands
```
Expected: the output lists `/backfill-prospect-forums` among the registered commands.

- [ ] **Step 3: Commit**

```
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot add src/commands/backfill-prospect-forums.js
git -C C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot commit -m "feat(prospects): add /backfill-prospect-forums owner command"
```

---

## Task 7: Shared types for `ProspectForumMessage`

**Files:**
- Modify: `C:/Users/OleEd/Azure/RoyalBattalionWebpage/packages/shared/types/tickets.ts`

- [ ] **Step 1: Add the `ProspectForumMessage` interface and wire it into `Prospect`**

Open `packages/shared/types/tickets.ts`. Add the new interface immediately after `ProspectVote` (currently ends around line 90):

```ts
export interface ProspectForumMessage {
  id: number;
  prospectId: number;
  messageId: string;
  authorId: string;
  authorTag: string;
  authorAvatar: string | null;
  isBot: boolean;
  content: string | null;
  attachments: string | null;
  embeds: DiscordEmbed[] | null;
  createdAt: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  author?: { name: string; url?: string; icon_url?: string };
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}
```

In the `Prospect` interface (currently around lines 35-60), add this line at the end of the property list, just after `votes?: ProspectVote[];`:

```ts
  forumMessages?: ProspectForumMessage[];
```

- [ ] **Step 2: Type-check the shared package**

The shared types compile into `packages/shared/dist`. Run from the web repo root:
```
bun run --filter shared build
```
Expected: clean output, no TypeScript errors.

- [ ] **Step 3: Commit**

```
git -C C:/Users/OleEd/Azure/RoyalBattalionWebpage add packages/shared
git -C C:/Users/OleEd/Azure/RoyalBattalionWebpage commit -m "feat(shared): add ProspectForumMessage and DiscordEmbed types"
```

---

## Task 8: Extend the API endpoint

**Files:**
- Modify: `C:/Users/OleEd/Azure/RoyalBattalionWebpage/packages/api/src/routes/tickets.ts`

- [ ] **Step 1: Add the query and the mapping inside the existing handler**

Locate the handler `tickets.get("/by-uuid/prospect/:uuid", ...)` (currently starts at line 26). After the `voteRows` query (currently around line 53-56), insert this new query:

```ts
  const forumRows: any[] = await getSecretaryDb().$queryRaw(Prisma.sql`
    SELECT id, prospect_id, message_id, author_id, author_tag, author_avatar,
           is_bot, content, attachments, embeds, created_at
      FROM prospect_forum_messages
     WHERE prospect_id = ${id}
     ORDER BY created_at ASC`
  );
```

Then, inside the `const prospect: Prospect = { ... }` object literal (currently around lines 58-107), append a new field at the end of the property list, right after the `votes: voteRows.map(...)` block. Note the closing comma:

```ts
    votes: voteRows.map((v) => ({
      id: v.id,
      prospectId: v.prospect_id,
      voterId: v.voter_id,
      voterTag: v.voter_tag,
      vote: v.vote,
      reason: v.reason,
      createdAt: new Date(v.created_at).toISOString(),
    })),
    forumMessages: forumRows.map((f) => ({
      id: f.id,
      prospectId: f.prospect_id,
      messageId: f.message_id,
      authorId: f.author_id,
      authorTag: f.author_tag,
      authorAvatar: f.author_avatar,
      isBot: Boolean(f.is_bot),
      content: f.content,
      attachments: f.attachments,
      embeds: parseEmbeds(f.embeds),
      createdAt: new Date(f.created_at).toISOString(),
    })),
```

Add the small helper near the top of the file, right under the imports (so it's reusable but local):

```ts
function parseEmbeds(raw: unknown): unknown[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}
```

(`prospect_forum_messages.embeds` is a MariaDB `JSON` column. Depending on the driver/version, Prisma returns it either pre-parsed as an array or as a JSON string. The helper handles both.)

- [ ] **Step 2: Boot the API locally**

Run from the web repo:
```
bun run dev:api
```
Expected: `API listening on http://localhost:3001` (or similar), no TypeScript errors.

- [ ] **Step 3: Hit the endpoint and confirm the new field shape**

In another terminal, with a real prospect UUID from your dev DB:
```
curl -s http://localhost:3001/tickets/by-uuid/prospect/<uuid> | jq '.data | {hasForumMessages: (.forumMessages != null), count: (.forumMessages | length)}'
```
Expected: `{ "hasForumMessages": true, "count": 0 }` for a prospect with no recorded forum messages yet. If the count is non-zero (after Task 6 has run), inspect one entry to verify field names match the schema.

- [ ] **Step 4: Commit**

```
git -C C:/Users/OleEd/Azure/RoyalBattalionWebpage add packages/api/src/routes/tickets.ts
git -C C:/Users/OleEd/Azure/RoyalBattalionWebpage commit -m "feat(api): include forumMessages in /tickets/by-uuid/prospect/:uuid response"
```

---

## Task 9: `ProspectForumEmbed` rendering component

**Files:**
- Create: `C:/Users/OleEd/Azure/RoyalBattalionWebpage/packages/web/app/(public)/prospect/[uuid]/ProspectForumEmbed.tsx`

This component renders one Discord embed JSON object as a card. It mirrors Discord's own visual idiom: a colored left stripe, a header row (author/title), body description, optional fields grid, image/thumbnail, footer.

- [ ] **Step 1: Create the component**

Create `packages/web/app/(public)/prospect/[uuid]/ProspectForumEmbed.tsx`:

```tsx
"use client";

import type { DiscordEmbed } from "shared";

function colorToHex(color?: number): string {
  if (!color) return "#5865f2";
  return "#" + color.toString(16).padStart(6, "0");
}

export function ProspectForumEmbed({ embed }: { embed: DiscordEmbed }) {
  const stripe = colorToHex(embed.color);

  return (
    <div
      className="my-2 flex overflow-hidden rounded-sm border border-border/40 bg-bg-tertiary/40"
      style={{ borderLeft: `4px solid ${stripe}` }}
    >
      <div className="flex-1 p-3">
        {embed.author?.name && (
          <div className="mb-1 flex items-center gap-2">
            {embed.author.icon_url && (
              <img
                src={embed.author.icon_url}
                alt=""
                className="h-5 w-5 rounded-full"
                loading="lazy"
              />
            )}
            <span className="text-xs font-medium text-text-secondary">
              {embed.author.name}
            </span>
          </div>
        )}

        {embed.title && (
          <div className="mb-1 text-sm font-semibold text-text-primary">
            {embed.url ? (
              <a
                href={embed.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline hover:text-accent-bright"
              >
                {embed.title}
              </a>
            ) : (
              embed.title
            )}
          </div>
        )}

        {embed.description && (
          <div className="mb-2 whitespace-pre-wrap text-sm text-text-secondary">
            {embed.description}
          </div>
        )}

        {embed.fields && embed.fields.length > 0 && (
          <div className="mb-2 grid gap-2 sm:grid-cols-2">
            {embed.fields.map((f, i) => (
              <div key={i} className={f.inline === false ? "sm:col-span-2" : undefined}>
                <div className="text-xs font-semibold text-text-primary">{f.name}</div>
                <div className="whitespace-pre-wrap text-xs text-text-secondary">{f.value}</div>
              </div>
            ))}
          </div>
        )}

        {embed.image?.url && (
          <a href={embed.image.url} target="_blank" rel="noopener noreferrer">
            <img
              src={embed.image.url}
              alt=""
              className="mt-1 max-h-64 max-w-full rounded-sm border border-border/30"
              loading="lazy"
            />
          </a>
        )}

        {embed.footer?.text && (
          <div className="mt-2 flex items-center gap-1 text-[10px] text-text-muted">
            {embed.footer.icon_url && (
              <img src={embed.footer.icon_url} alt="" className="h-3 w-3 rounded-full" />
            )}
            <span>{embed.footer.text}</span>
          </div>
        )}
      </div>

      {embed.thumbnail?.url && (
        <a
          href={embed.thumbnail.url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 p-3"
        >
          <img
            src={embed.thumbnail.url}
            alt=""
            className="max-h-20 max-w-20 rounded-sm border border-border/30"
            loading="lazy"
          />
        </a>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```
git -C C:/Users/OleEd/Azure/RoyalBattalionWebpage add packages/web/app/\(public\)/prospect/\[uuid\]/ProspectForumEmbed.tsx
git -C C:/Users/OleEd/Azure/RoyalBattalionWebpage commit -m "feat(web): add ProspectForumEmbed component for Discord embed rendering"
```

---

## Task 10: "Forum Discussion" section on the prospect page

**Files:**
- Modify: `C:/Users/OleEd/Azure/RoyalBattalionWebpage/packages/web/app/(public)/prospect/[uuid]/page.tsx`

The page is a client component using shared helpers (`Linkify`, `MessageAttachments`). We add a new section that reuses those helpers and pulls in the new embed component.

- [ ] **Step 1: Import the new component and the new type**

At the top of `page.tsx`, alongside the existing imports, add:

```tsx
import { ProspectForumEmbed } from "./ProspectForumEmbed";
import type { Prospect, ProspectForumMessage } from "shared";
```

Replace the existing single-line `import type { Prospect } from "shared";` if present; otherwise add `ProspectForumMessage` to the existing type import. The end result is one combined `import type` line so we don't import `Prospect` twice.

- [ ] **Step 2: Insert the Forum Discussion section**

Locate the existing **Votes** block (currently around lines 250-270, the JSX `{prospect.votes && prospect.votes.length > 0 && (...)}`). Immediately after that block's closing `)` and before the **Events timeline** block, insert the new section:

```tsx
{/* Forum Discussion */}
<div className="facet-border mb-6 rounded-sm bg-bg-card p-5">
  <h2 className="font-display mb-4 text-lg font-semibold tracking-wide">Forum Discussion</h2>
  {prospect.forumMessages && prospect.forumMessages.length > 0 ? (
    <div className="space-y-3">
      {prospect.forumMessages.map((msg: ProspectForumMessage) => (
        <div
          key={msg.id}
          className={`rounded-sm border p-4 ${
            msg.isBot
              ? "border-accent/20 bg-accent/5"
              : "border-border/50 bg-bg-tertiary/30"
          }`}
        >
          <div className="mb-2 flex items-center gap-2">
            {msg.authorAvatar && (
              <img
                src={msg.authorAvatar}
                alt=""
                className="h-5 w-5 rounded-full"
                loading="lazy"
              />
            )}
            <span className="text-sm font-medium text-text-primary">
              {msg.authorTag}
            </span>
            {msg.isBot && (
              <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent uppercase">
                Bot
              </span>
            )}
            <span className="text-xs text-text-muted">
              {new Date(msg.createdAt).toLocaleString()}
            </span>
          </div>
          {msg.content && (
            <p className="whitespace-pre-wrap text-sm text-text-secondary">
              <Linkify text={msg.content} />
            </p>
          )}
          <MessageAttachments attachments={msg.attachments} />
          {msg.embeds && msg.embeds.length > 0 && (
            <div className="mt-2">
              {msg.embeds.map((embed, i) => (
                <ProspectForumEmbed key={i} embed={embed} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  ) : (
    <p className="text-sm text-text-muted">No forum discussion recorded.</p>
  )}
</div>
```

This reuses `Linkify` and `MessageAttachments` already defined at the top of the file — no duplication.

- [ ] **Step 3: Build the web package and check for type errors**

Run from the web repo root:
```
bun run --filter web build
```
Expected: build succeeds. No TS errors referencing `forumMessages` or `ProspectForumEmbed`.

- [ ] **Step 4: Commit**

```
git -C C:/Users/OleEd/Azure/RoyalBattalionWebpage add packages/web/app/\(public\)/prospect/\[uuid\]/page.tsx
git -C C:/Users/OleEd/Azure/RoyalBattalionWebpage commit -m "feat(web): render forum-discussion section on prospect transcript page"
```

---

## Task 11: End-to-end manual verification on staging

This is the only verification pass for the feature, because neither repo has automated tests today. Do not skip steps.

- [ ] **Step 1: Deploy the bot to staging**

Push the bot branch and deploy via the project's standard staging pipeline. Confirm the boot log contains the `Initializing database schema...` line and that the new table exists in staging:
```sql
SHOW CREATE TABLE prospect_forum_messages;
```

- [ ] **Step 2: Deploy the web changes to staging**

Push the webpage branch and confirm both web and API are running against the same staging DB.

- [ ] **Step 3: Live capture — member message**

In the staging Discord, pick an existing accepted prospect (one with a `forum_thread_id`). As any clan member, post a message in the prospect's forum thread:
> "test message for transcript capture"

Then load `https://stg.royalbattalion.xyz/prospect/<uuid>` and confirm:
- The new "Forum Discussion" section is present, positioned between "Votes" and "Timeline."
- The test message appears with the member's avatar and tag.
- The timestamp is approximately now.

- [ ] **Step 4: Live capture — bot embeds**

If the prospect in step 3 had no bot embeds yet, trigger the vote start (let the scheduler run or use the manual control if available). Confirm the vote embed appears in the section, rendered as an embed card (left stripe in the embed's color, title, fields), in chronological position.

- [ ] **Step 5: Backfill — `/backfill-prospect-forums`**

Pick a different open prospect that has existing forum messages but no rows in `prospect_forum_messages` yet. Run `/backfill-prospect-forums`. Expected reply (ephemeral): one line per prospect with `N new / N scanned` counts. Reload that prospect's page and confirm historical messages now appear.

- [ ] **Step 6: Idempotency**

Run `/backfill-prospect-forums` again immediately. Expected: each prospect now shows `0 new / N scanned` (everything already captured). The web page is unchanged.

- [ ] **Step 7: Close-flush**

Pick the test prospect from step 3 (or any disposable one). Post one final message in the thread. Immediately close the prospect (accept or deny) from the staff channel. The thread will be deleted in Discord. Then reload `/prospect/<uuid>` and confirm the final message is still present in the section. Check the bot logs for the `Final forum flush before delete` info line with its `inserted`/`scanned` counts.

- [ ] **Step 8: Empty-state**

For a prospect that has a forum thread but no recorded messages (rare — possibly an older one that was never backfilled and ran before deploy), confirm the section renders `"No forum discussion recorded."`

- [ ] **Step 9: Smoke test — no regressions in existing prospect features**

For the same prospect used above:
- The existing Messages section (DM relay) still renders correctly.
- Votes section still renders.
- Timeline section still renders.
- The Discord side: DM relay still works, !reply still works, !close still works.

- [ ] **Step 10: Final commit / cleanup**

If any tweaks were needed during verification, commit them. Otherwise the feature is shippable. Open PRs against the bot and webpage main branches as usual.

---

## Self-review notes

Spec coverage:
- Schema (spec §Storage) — Task 1.
- Live capture handler + router rewiring (spec §Bot capture pipeline → Live capture, Routing change) — Tasks 3, 4.
- Final-flush on close (spec §Final flush on close) — Task 5.
- Backfill command (spec §Backfill command) — Task 6.
- Service layer (`saveForumMessage`, `backfillForumThread`) (spec §Bot capture pipeline → Service additions) — Task 2.
- Shared types (spec §Webpage API) — Task 7.
- API endpoint extension (spec §Webpage API) — Task 8.
- Embed rendering component + page section (spec §Website display) — Tasks 9, 10.
- Manual testing (spec §Testing) — Task 11 covers all enumerated checks.

Type consistency:
- Bot inserts: `prospect_id, message_id, author_id, author_tag, author_avatar, is_bot, content, attachments, embeds, created_at` — same column list used by `INSERT IGNORE` (Task 2) and the `SELECT` in the API (Task 8).
- `ProspectForumMessage` field names match the SQL aliases mapped in Task 8: `messageId/message_id`, `authorAvatar/author_avatar`, `isBot/is_bot`, etc.
- `DiscordEmbed` shape in Task 7 matches the keys consumed by `ProspectForumEmbed.tsx` in Task 9 (`color`, `author.name`, `author.icon_url`, `title`, `url`, `description`, `fields[].name/value/inline`, `image.url`, `thumbnail.url`, `footer.text/icon_url`).
- Service function names referenced across tasks: `saveForumMessage`, `backfillForumThread`, `getProspectByForumThread`, `handleForumThread` — all consistent.
- Helper `parseEmbeds` (Task 8) returns `unknown[] | null`; the typed `Prospect.forumMessages[].embeds` is `DiscordEmbed[] | null`. The cast happens implicitly via `as` is unnecessary because the runtime shape matches; the consumer `ProspectForumEmbed` types `embed: DiscordEmbed` so unparseable shapes render as best-effort. This is intentional — we accept whatever discord.js gave us.

Placeholders / red flags: none. All steps include concrete code, exact paths, and expected outputs.
