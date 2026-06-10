# Prospect Transcript Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a website transcript link (`<webBaseUrl>/prospect/<uuid>`) to the staff-facing prospect info embed in Discord, plus an owner-only command to backfill the link onto all currently-open prospect tickets.

**Architecture:** A single conditional field added inside `buildProspectInfoEmbed` covers new prospects (existing call sites already pass the full `prospect` record with `uuid`). For backfill, a new owner-only slash command iterates open prospects, locates each ticket's top message by its prospect buttons, rebuilds the embed via the existing builder, then re-appends stats via the existing `appendAllStatsToMessage` (which needs to be exported). To avoid duplicating the component-selection logic that lives in `prospectService.js`, the plan adds one small exported helper that picks the right component set from the prospect's state and performs the edit.

**Tech Stack:** Bun, discord.js v14, MariaDB. ESM only. No test framework — verification is manual via the staging guild.

**Spec:** `docs/superpowers/specs/2026-05-16-prospect-transcript-link-design.md`

---

## File Structure

- Modify: `src/services/prospect/prospectEmbeds.js` — add the `Transcript` field in `buildProspectInfoEmbed`.
- Modify: `src/services/prospect/prospectService.js` — export `appendAllStatsToMessage`; add a new exported helper `refreshProspectTopMessage(prospect, guild)` used by the backfill command.
- Create: `src/commands/refresh-prospect-embeds.js` — owner-only slash command.
- Modify: `package.json` — bump patch version per the project's per-push semver rule (Discord bot starts `2.0.0`; current `2.1.2` → `2.1.3`).

---

## Task 1: Add the Transcript field to `buildProspectInfoEmbed`

**Files:**
- Modify: `src/services/prospect/prospectEmbeds.js:6-64`

- [ ] **Step 1: Add the conditional `Transcript` field**

In `buildProspectInfoEmbed`, immediately after the existing `if (forumUrl) { ... }` block (currently at lines 55-57), append:

```js
  if (config.webBaseUrl && prospect.uuid) {
    const host = new URL(config.webBaseUrl).host;
    const shortUuid = prospect.uuid.slice(0, 6);
    embed.addFields({
      name: 'Transcript',
      value: `[${host}/prospect/${shortUuid}](${config.webBaseUrl}/prospect/${prospect.uuid})`,
      inline: true,
    });
  }
```

The `config` import already exists at the top of the file (line 4). The `prospect.uuid` guard is defensive in case a future caller passes a partial record.

- [ ] **Step 2: Manually verify on a sample**

Run a quick syntax sanity check (no test framework exists):

```bash
bun -e "import('./src/services/prospect/prospectEmbeds.js').then(m => console.log(Object.keys(m)))"
```

Expected: prints the exports array including `buildProspectInfoEmbed`. No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/prospect/prospectEmbeds.js
git commit -m "feat(prospect): add transcript link to staff info embed"
```

---

## Task 2: Export `appendAllStatsToMessage` from prospectService

The backfill helper needs to re-append stats after editing the top embed. The function is currently module-private.

**Files:**
- Modify: `src/services/prospect/prospectService.js:173`

- [ ] **Step 1: Change the function declaration to be exported**

Change line 173 from:

```js
function appendAllStatsToMessage(message, steamId, userId, prospect) {
```

to:

```js
export function appendAllStatsToMessage(message, steamId, userId, prospect) {
```

No other changes. All existing in-file callers continue to work unchanged.

- [ ] **Step 2: Syntax sanity check**

```bash
bun -e "import('./src/services/prospect/prospectService.js').then(m => console.log('appendAllStatsToMessage' in m))"
```

Expected: prints `true`.

- [ ] **Step 3: Commit**

```bash
git add src/services/prospect/prospectService.js
git commit -m "refactor(prospect): export appendAllStatsToMessage for reuse"
```

---

## Task 3: Add `refreshProspectTopMessage` helper

This helper centralises the "look up the prospect's top message, rebuild its embed and components from current state, re-append stats" dance that the backfill command will call once per prospect. It does NOT yet replace the equivalent logic in `claimProspect`/accept/etc. (those have additional notification side-effects — out of scope).

**Files:**
- Modify: `src/services/prospect/prospectService.js`

- [ ] **Step 1: Add the helper near the bottom of the file**

Append this function after the last existing export in `prospectService.js`. Place it before the file's final closing (find a clear insertion point at the end of the existing exports — e.g., after the last `export async function ...` definition).

```js
/**
 * Re-render a prospect's top staff-channel embed using its current DB state.
 * Picks the correct component set based on mentor/forum status, edits the
 * top message, and re-appends stats. Returns a short status string suitable
 * for inclusion in a slash-command summary.
 */
export async function refreshProspectTopMessage(prospect, guild) {
  if (!prospect.channel_id) return 'skipped:no-channel-id';

  const channel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (!channel) return 'skipped:channel-not-found';

  const member = await guild.members.fetch(prospect.user_id).catch(() => null);
  const bmPlayerId = !isTestSteamId(prospect.steam_id)
    ? await bm.resolvePlayerId(prospect.steam_id).catch(() => null)
    : null;

  const forumUrl = prospect.forum_thread_id
    ? `https://discord.com/channels/${guild.id}/${prospect.forum_thread_id}`
    : null;

  const infoEmbed = buildProspectInfoEmbed(member, prospect, forumUrl, bmPlayerId);

  // Component set mirrors the rules used by claimProspect / acceptProspect:
  //   - no mentor                          -> claim/deny           (buildProspectComponents)
  //   - mentor, no forum thread            -> accept/deny/unclaim  (buildProspectComponents)
  //   - mentor + forum thread (in-period)  -> extend/test_vote/deny (buildProspectAcceptedComponents)
  const components = prospect.forum_thread_id
    ? buildProspectAcceptedComponents(prospect)
    : buildProspectComponents(prospect);

  // Look up the top message by any prospect button it might currently host.
  const topMsg = await findBotMessageByCustomId(channel, guild.client.user.id, [
    'prospect_claim',
    'prospect_accept',
    'prospect_deny',
    'prospect_unclaim',
    'prospect_extend',
    'prospect_test_vote',
  ]);
  if (!topMsg) return 'skipped:no-top-message';

  await topMsg.edit({ embeds: [infoEmbed], components });
  appendAllStatsToMessage(topMsg, prospect.steam_id, prospect.user_id, prospect);
  return 'refreshed';
}
```

The button list passed to `findBotMessageByCustomId` is the union of every button that has appeared on a prospect top message across `buildProspectComponents` and `buildProspectAcceptedComponents`. `findBotMessageByCustomId` already accepts an array (`src/utils/messageSearch.js:4-13`).

- [ ] **Step 2: Verify the helper imports resolve**

```bash
bun -e "import('./src/services/prospect/prospectService.js').then(m => console.log('refreshProspectTopMessage' in m))"
```

Expected: prints `true`. No import errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/prospect/prospectService.js
git commit -m "feat(prospect): add refreshProspectTopMessage helper"
```

---

## Task 4: Add the `/refresh-prospect-embeds` slash command

**Files:**
- Create: `src/commands/refresh-prospect-embeds.js`

- [ ] **Step 1: Create the command file**

```js
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { query } from '../database/connection.js';
import { refreshProspectTopMessage } from '../services/prospect/prospectService.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:refresh-prospect-embeds' });

const OWNER_ID = '195412349153312768';

const PROSPECT_COLUMNS = [
  'id', 'uuid', 'channel_id', 'forum_thread_id', 'user_id', 'status',
  'alias', 'nationality', 'date_of_birth', 'squad_hours', 'preferred_roles',
  'prev_clan', 'why_rb', 'active_hours', 'competitive', 'steam_id',
  'mentor_id', 'vote_posted_at', 'vote_message_id', 'created_at',
  'closed_at', 'closed_by', 'extra_days', 'paused_at', 'period_started_at',
  'ai_evaluation',
].join(', ');

export default {
  data: new SlashCommandBuilder()
    .setName('refresh-prospect-embeds')
    .setDescription('Re-render the top embed of every open prospect ticket (owner only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ embeds: [errorEmbed('This command is restricted.')], flags: ['Ephemeral'] });
    }

    await interaction.deferReply({ flags: ['Ephemeral'] });

    try {
      const prospects = await query(
        `SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE status = ? AND channel_id IS NOT NULL ORDER BY id ASC`,
        ['open']
      );

      const counts = { refreshed: 0, 'skipped:no-channel-id': 0, 'skipped:channel-not-found': 0, 'skipped:no-top-message': 0, error: 0 };
      const errors = [];

      for (const prospect of prospects) {
        try {
          const outcome = await refreshProspectTopMessage(prospect, interaction.guild);
          counts[outcome] = (counts[outcome] ?? 0) + 1;
        } catch (err) {
          counts.error += 1;
          errors.push(`#${prospect.id} (${prospect.alias ?? 'unknown'}): ${err.message}`);
          log.warn({ err, prospectId: prospect.id }, 'refreshProspectTopMessage failed');
        }
        if ((counts.refreshed + counts.error) % 10 === 0) {
          log.info({ processed: counts.refreshed + counts.error, total: prospects.length }, 'refresh progress');
        }
      }

      const summaryLines = [
        `Total open prospects: ${prospects.length}`,
        `Refreshed: ${counts.refreshed}`,
        `Skipped (no channel id): ${counts['skipped:no-channel-id']}`,
        `Skipped (channel not found): ${counts['skipped:channel-not-found']}`,
        `Skipped (no top message): ${counts['skipped:no-top-message']}`,
        `Errors: ${counts.error}`,
      ];
      if (errors.length > 0) {
        summaryLines.push('', 'Errors:', ...errors.slice(0, 10));
        if (errors.length > 10) summaryLines.push(`...and ${errors.length - 10} more (see logs)`);
      }

      log.info({ counts }, 'Prospect embed refresh complete');
      await interaction.editReply({ embeds: [successEmbed(summaryLines.join('\n'))] });
    } catch (err) {
      log.error({ err }, 'Prospect embed refresh failed');
      await interaction.editReply({ embeds: [errorEmbed(`Refresh failed: ${err.message}`)] });
    }
  },
};
```

The command is auto-loaded by the command loader (per the bot's "drop a file in commands/" pattern documented in `CLAUDE.md`). No wiring required.

- [ ] **Step 2: Register the new command with Discord**

Run:

```bash
bun run deploy-commands
```

Expected output: log lines confirming the slash command was registered, including a line mentioning `refresh-prospect-embeds`. If running locally against the dev guild, the command appears immediately in that guild.

- [ ] **Step 3: Commit**

```bash
git add src/commands/refresh-prospect-embeds.js
git commit -m "feat(prospect): add /refresh-prospect-embeds owner command"
```

---

## Task 5: Bump the bot version

Per the project's per-push semver rule (memory: "Bump semver on every push").

**Files:**
- Modify: `package.json:3`

- [ ] **Step 1: Bump patch**

Change `"version": "2.1.2"` to `"version": "2.1.3"`.

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 2.1.3"
```

---

## Task 6: Manual verification on staging

This is the only end-to-end check. Do it before pushing to production.

- [ ] **Step 1: Boot the bot against the staging guild**

```bash
NODE_ENV=staging bun run start
```

Watch the boot log for the `[boot] bot environment` line. Confirm `webBaseUrl` matches the staging URL (`https://stg.royalbattalion.xyz`).

- [ ] **Step 2: Open a fresh prospect application**

Use the staging guild's Prospect panel to submit a test application. Open the resulting staff channel.

Expected: the top embed shows a `Transcript` field with `stg.royalbattalion.xyz/prospect/<6-char-prefix>` as visible text, linking to the full UUID URL.

- [ ] **Step 3: Run `/refresh-prospect-embeds` on staging**

In the staging guild, run the new slash command.

Expected: ephemeral reply summarising `Refreshed: N`, no errors. The freshly created prospect (and any other open prospects on staging) now show the `Transcript` field. Buttons (`Claim`/`Deny` or whatever state the prospect is in) remain functional — click `Claim` and confirm the claim flow still works.

- [ ] **Step 4: Re-run the command immediately**

Run `/refresh-prospect-embeds` again.

Expected: same `Refreshed: N` count, no errors. Discord shows no visible change (edit with identical content is a no-op).

- [ ] **Step 5: Verify graceful absence of `webBaseUrl`**

Temporarily comment out the `webBaseUrl` line in `settings.staging.js`, restart the bot, open a new prospect.

Expected: embed renders without the `Transcript` field. No errors in the log.

Restore `settings.staging.js` before exiting this step.

---

## Notes for the executor

- **Conventional commits, one-liners, no Claude attribution** — global user preference. No `Co-Authored-By` footers.
- **No emoji** in code, commit messages, or generated content.
- **Do not push** until the user explicitly authorises a push. After Task 6 passes, hand back for sign-off.
