# Code Review Findings (2026-04-09)

All findings resolved on 2026-04-09.

## CRITICAL

### Security

- [x] **C1: Verify answer leaks correct index in button customId** -- `handlers/verifyButtons.js` -- correct answer now stored server-side in `pendingVerifications` Map; customId is just `verify_answer_${i}`.
- [x] **C2: AI prompt injection** -- `services/ai/prospectAiService.js` -- user-supplied fields wrapped in `<application_data>` XML tags; system prompt instructs to treat as untrusted input.
- [x] **C3: Git credentials logged** -- `services/configGuardian/configGuardianBackup.js` -- error messages sanitized to strip PAT tokens from git URLs before logging.
- [x] **C4: Steam API key in error logs** -- `services/steamService.js` -- catch blocks now log `err.message` instead of full `err` object.

### Bugs / Data Integrity

- [x] **C5: Text commands `!close`, `!reply`, `!anonymous_reply` lack permission checks** -- `handlers/ticketMessages.js` -- added `hasAnyRole` check using ticket staff roles before executing.
- [x] **C6: Anonymous mode lost on bot restart** -- `services/ticket/ticketService.js` -- persisted in DB (`anonymous_mode` column on tickets table), restored on startup via `restoreAnonymousModes()`.
- [x] **C7: `acceptProspect` overwrites `created_at` with NOW()** -- `services/prospect/prospectService.js` -- added `period_started_at` column; `acceptProspect` sets it instead of overwriting `created_at`. Date calculations use `COALESCE(period_started_at, created_at)`.
- [x] **C8: Socket.IO watchdog interval never cleared on `disconnect()`** -- `services/seeding/seedingSocket.js` -- interval stored in module-level variable and cleared in `disconnect()`.
- [x] **C9: `config.prospects` accessed without optional chaining** -- `events/guildMemberUpdate.js` -- changed to `config.prospects?.mentorRoleId`.
- [x] **C10: `actionProcessor` never stopped during shutdown** -- `src/index.js` -- imported and called `stopActionProcessor()` in shutdown handler.
- [x] **C11: `flushLogs` only drains one batch** -- `services/admin/logTransport.js` -- now loops `while (buffer.length > 0) await flush()`.
- [x] **C12: Battlemetrics config spread order** -- `src/config.js` -- swapped spread order so env vars take precedence over settings.

## WARNING

- [x] **W1:** `ready.js` -- each init call now wrapped individually via `safeInit(label, fn)` helper.
- [x] **W2:** `src/index.js` -- added `shuttingDown` boolean guard to prevent double shutdown.
- [x] **W3:** `ticketService.js:reopenTicket` -- uses atomic `UPDATE ... WHERE status = 'closing'` with `affectedRows` check. Callers in `ticketButtons.js`, `messageCreate.js`, and `actionProcessor.js` handle the error return.
- [x] **W4:** `messageSearch.js` -- fetch limit increased to 100. `info_message_id` column added to tickets; `findTicketInfoMessage()` falls back to stored ID.
- [x] **W5:** `handlers/prospectModals.js:handleVoteNoModal` -- added `requireRole` check matching other handlers.
- [x] **W6:** `prospectEmbeds.js` -- "(PAUSED)" appended to "Period Ends" and "Vote Date" fields when `prospect.paused_at` is set.
- [x] **W7:** `prospectButtons.js` -- added design comment documenting that "unsure" votes are intentionally excluded from pass/fail ratio.
- [x] **W8:** `database/connection.js:createPools` -- falsy DB names now skipped with warning log.
- [x] **W9:** `events/interactionCreate.js` -- `verify_answer_` prefix exempted from global 2s cooldown.
- [x] **W10:** `events/messageReactionAdd.js` -- partial `reaction` and `user` now fetched before processing.
- [x] **W11:** `handlers/activityButtons.js` -- fallback `editReply` added in catch block.
- [x] **W12:** `whitelistService.js:upsertSeederEntry` -- now checks all entries via `.some()` for active non-Seeder whitelist.
- [x] **W13:** `seedingScheduler.js` already had `last_daily_call_date` DB guard; `configGuardianScheduler.js` now has `lastBackupDate` guard.
- [x] **W14:** `seedTrackerScheduler.js` -- refactored to use `createScheduler` which calls `tick()` immediately on start.
- [x] **W15:** `seedingScheduler.js` -- replaced `guild.members.fetch()` with `guild.roles.cache.get(roleId)?.members?.size`. `voiceTracker.js` -- targeted fetch of only voice-active members.

## DRY / MAINTAINABILITY

### Duplicated Functions (extracted to shared utils)

- [x] **D1:** `generateId` extracted to `src/utils/id.js`; imported in `userService.js` and `whitelistService.js`.
- [x] **D2:** `getLayerImageUrl` canonical in `seedingEmbeds.js`; imported in `serverStatusEmbeds.js`.
- [x] **D3:** `formatDuration` extracted to `src/utils/formatters.js`; imported in `activityEmbeds.js` and `seedTrackerEmbeds.js`.
- [x] **D4:** `formatDate` added to `src/utils/formatters.js`; imported in `aiService.js` and `prospectAiService.js`.
- [x] **D5:** `refreshStaffEmbed` canonical in `prospectService.js`; imported in `teamRoleService.js`.
- [x] **D6:** Anthropic client extracted to `src/services/ai/anthropicClient.js` with `getAnthropicClient()` and `isAnthropicAvailable()`.

### Duplicated Patterns (extracted to shared abstractions)

- [x] **D7:** `safeReply` helper extracted in `events/interactionCreate.js`; replaced 3 duplicate blocks.
- [x] **D8:** `CooldownManager` class extracted to `src/utils/cooldown.js`; used in `verifyButtons.js` and `interactionCreate.js`.
- [x] **D9:** `createScheduler` factory created in `src/utils/scheduler.js`; refactored `seedingScheduler`, `seedTrackerScheduler`, `configGuardianScheduler`, `activityScheduler`.
- [x] **D10:** `rebuildTicketInfoEmbed` extracted in `ticketService.js`; used from `ticketButtons.js` and `messageCreate.js`.
- [x] **D11:** Ticket creation merged into single `createTicketFromModal(interaction, opts)` in `ticketModals.js`.
- [x] **D12:** `TIER_LABELS` and `TIER_COLORS` exported from `ticketEmbeds.js`; imported in `ticketService.js`.
- [x] **D13:** `isTestSteamId(id)` added to `prospectService.js`; replaced 6+ inline `=== 'Q'` checks.
- [x] **D14:** `getProspectDates(prospect)` added to `prospectService.js`; used in embeds, scheduler, and voting.
- [x] **D15:** `panelManager.ensurePanel` refactored to delegate to `findBotMessageByCustomId` internally.
- [x] **D16:** `safeFetch` utility created in `src/utils/fetchHelpers.js` (available for adoption).

## SUGGESTIONS

- [x] **S1:** `!logs` page number now wired up to query/display in `handlers/ticketMessages.js`.
- [x] **S2:** Hardcoded Discord user ID replaced with generic text in `events/messageCreate.js`.
- [x] **S3:** `prospect_scheduler_active` now uses `isSchedulerActive()` import in `statusHeartbeat.js`.
- [x] **S4:** "Q" Steam ID shortcut gated behind `NODE_ENV !== 'production'` in `steamService.js`.
- [x] **S5:** Insufficient playtime warning tracked per-prospect via in-memory Set in `prospectScheduler.js`.
- [x] **S6:** Personal email replaced with `process.env.GIT_AUTHOR_EMAIL || 'bot@royalbattalion.com'` in `configGuardianBackup.js`.
- [x] **S7:** `trySendWithFiles` no longer mutates caller's options object in `utils/discord.js`.
- [x] **S8:** Unused imports removed from `actionProcessor.js`.
- [x] **S9:** `TIER_SHORT` map now includes `comp_team` and `whitelist` in `handlers/ticketMessages.js`.
- [x] **S10:** Vote thresholds now config-driven (`config.prospects.minYesVotes`, `config.prospects.minYesRate`) in `prospectButtons.js`.
- [x] **S11:** `MODIFY COLUMN` statements in `schema.js` wrapped with `.catch()` for idempotent re-runs (logged at `warn`).

## Cross-Cutting

- [ ] **Semicolons:** Inconsistent across the codebase. Deferred to linter setup (separate PR).
- [x] **Magic numbers:** Vote thresholds extracted to config (S10); other key thresholds addressed per-finding.
- [x] **Error handling:** `safeReply` helper (D7), `safeFetch` utility (D16), `safeInit` pattern (W1) standardize error handling in their domains.

## New Files Created

| File | Purpose |
|------|---------|
| `src/utils/cooldown.js` | Shared `CooldownManager` class (D8) |
| `src/utils/scheduler.js` | Scheduler factory with guard, logging, initial tick (D9) |
| `src/utils/id.js` | Shared CUID generator (D1) |
| `src/utils/formatters.js` | Shared `formatDate` + `formatDuration` (D3, D4) |
| `src/utils/fetchHelpers.js` | Shared `safeFetch` wrapper (D16) |
| `src/services/ai/anthropicClient.js` | Shared Anthropic client singleton (D6) |

## Known Follow-ups

- Circular import between `prospectService.js` and `teamRoleService.js` (from D5) -- works in ESM but could be extracted to a separate module for cleanliness.
- `fetchHelpers.js` created but not yet adopted by existing API services -- available for incremental adoption.
- Semicolons: pick a style and enforce with linter config (separate PR).
