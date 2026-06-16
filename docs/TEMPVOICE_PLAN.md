# TempVoice Integration into Royal Secretary

## Context

The Royal Battalion Discord bot needs temporary voice channel functionality. Users should be able to join a trigger voice channel, get their own private temp channel created automatically, and manage it via a control panel in the voice channel's built-in text chat. All 15 features from the [tempvoice](https://github.com/jevenchy/tempvoice) bot will be ported, adapted to the Royal Battalion theme, English only, and using MariaDB instead of SQLite.

**Key design change**: Instead of a single dedicated settings channel (like tempvoice does), the control panel embed lives in each voice channel's text chat -- one per channel.

---

## Feasibility Assessment

**Verdict: Fully doable, no limitations.**

| Concern | Status |
|---------|--------|
| Voice state tracking | Already has `GuildVoiceStates` intent + voice tracker |
| Button/modal routing | Existing handler pattern supports unlimited additions |
| Database | MariaDB ready, just add 2 tables |
| Permissions | Bot already manages complex permission overwrites (tickets, prospects) |
| Auto-loading | Drop files in the right dirs, they're discovered |
| Channel management | discord.js v14 fully supports programmatic VC creation/deletion |
| Voice channel text chat | discord.js supports sending messages to voice channels natively |
| Rate limiting | Already has per-user cooldowns; can add tempvoice-specific limiter |
| Recovery on restart | Bot already recovers voice sessions + ticket timers on startup |

No new intents, no new dependencies, no breaking changes to existing features.

---

## Features (all 15 from tempvoice)

| # | Feature | Button ID | Description |
|---|---------|-----------|-------------|
| 1 | Rename | `tv_name` | Modal: rename channel (content filtered) |
| 2 | User Limit | `tv_limit` | Modal: set 0-99 user cap |
| 3 | Privacy | `tv_privacy` | Select menu: Lock/Unlock/Invisible/Visible/Open Chat/Close Chat |
| 4 | DND | `tv_dnd` | Toggle: disable all voice perms for channel |
| 5 | Region | `tv_region` | Select menu: voice region picker |
| 6 | Trust | `tv_trust` | User select: grant user access |
| 7 | Untrust | `tv_untrust` | User select: revoke user access |
| 8 | Block | `tv_block` | User select: deny all perms for user |
| 9 | Unblock | `tv_unblock` | User select: remove block |
| 10 | Bitrate | `tv_bitrate` | Select menu: 32/48/64/80/96 kbps |
| 11 | Invite | `tv_invite` | User select: create 24h invite, DM to user |
| 12 | Kick | `tv_kick` | Select menu: disconnect a user from channel |
| 13 | Claim | `tv_claim` | Claim ownership if owner left |
| 14 | Transfer | `tv_transfer` | User select: hand ownership to another member |
| 15 | Delete | `tv_delete` | Delete the channel immediately |

Plus: auto-create on join, auto-delete on empty, auto-cleanup (24h inactive), max 3 channels/user, DB persistence, bot restart recovery.

### Design Decisions
- **Default channel name**: `{username}'s Channel` (e.g. "OleEd's Channel")
- **Staff bypass**: Yes -- members with Administrator permission can manage any temp channel (kick, rename, delete, etc.), not just their own. Ownership checks: `isOwner || hasAdminPermission`.
- **Logging**: Yes -- optional log channel configured via `/tempvoice-setup`. Events (create, delete, rename, kick, block, transfer, claim) logged as embeds to that channel.
- **Trigger VC**: User picks an existing voice channel via `/tempvoice-setup` command. No auto-creation.

---

## Architecture

### New Files

```
src/services/tempvoice/
  tempvoiceService.js    -- DB operations (CRUD for channels + config)
  tempvoiceEmbeds.js     -- Control panel embed + 3 rows of buttons
  tempvoiceManager.js    -- Core orchestration: create/delete/permissions/cleanup/recovery
  contentFilter.js       -- Channel name validation & sanitization

src/handlers/
  tempvoiceButtons.js    -- 15 button interaction handlers
  tempvoiceModals.js     -- Name + Limit modal submit handlers

src/commands/
  tempvoice-setup.js     -- /tempvoice-setup: configure trigger VC, category, log channel
```

### Modified Files

| File | Change |
|------|--------|
| `src/database/schema.js` | Add `temp_voice_config` + `temp_channels` tables |
| `src/events/voiceStateUpdate.js` | Add `handleTempVoiceStateUpdate()` call |
| `src/events/interactionCreate.js` | Register 15 button + 2 modal handlers in routing maps |
| `src/events/ready.js` | Add `initFromDb()` recovery + `startCleanupScheduler()` |
| `src/index.js` | Add `stopCleanupScheduler()` to shutdown |

### Database Tables (MariaDB)

**`temp_voice_config`** -- Singleton config (like `seeding_config`)
```sql
CREATE TABLE IF NOT EXISTS temp_voice_config (
  id INT PRIMARY KEY DEFAULT 1,
  trigger_channel_id VARCHAR(20),
  category_id VARCHAR(20),
  log_channel_id VARCHAR(20),
  max_channels_per_user INT DEFAULT 3,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CHECK (id = 1)
);
```

**`temp_channels`** -- Active channel registry
```sql
CREATE TABLE IF NOT EXISTS temp_channels (
  id INT AUTO_INCREMENT PRIMARY KEY,
  channel_id VARCHAR(20) NOT NULL UNIQUE,
  owner_id VARCHAR(20) NOT NULL,
  guild_id VARCHAR(20) NOT NULL,
  panel_message_id VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tc_owner (owner_id),
  INDEX idx_tc_guild (guild_id)
);
```

### In-Memory State (tempvoiceManager.js)

```js
const activeChannels = new Map();  // channelId -> { ownerId, guildId, panelMessageId }
const creationLocks = new Set();   // userId -- prevents race conditions
const deletedChannels = new Set(); // channelId -- prevents double-delete
```

---

## Control Panel Design

Sent to the voice channel's text chat when the channel is created.

**Embed**: Royal Battalion themed, blurple color (`0x5865f2`), footer "Royal Battalion -- TempVoice", description explaining controls.

**Button Layout** (3 rows of 5):
```
Row 1: [Name] [Limit] [Privacy] [DND] [Region]
Row 2: [Trust] [Untrust] [Block] [Unblock] [Bitrate]
Row 3: [Invite] [Kick] [Claim] [Transfer] [Delete (red)]
```

All buttons Secondary style except Delete which is Danger. Unicode emojis on each button.

---

## Voice State Flow

1. **Join trigger VC** -> check creation lock -> check quota (max 3) -> create VC in category -> set permissions -> move user -> send control panel to VC text chat -> save to DB + memory
2. **Leave temp VC** -> if empty, check `deletedChannels` set -> delete channel -> remove from DB + memory
3. **Owner leaves, others remain** -> channel stays, others can use `tv_claim`
4. **Activity touch** -> any join/switch into temp channel updates `last_activity`

## Permission Model

| Action | @everyone | Trusted User | Blocked User | Owner |
|--------|-----------|-------------|-------------|-------|
| Default | View + Connect | -- | -- | ManageChannels, MuteMembers, DeafenMembers, MoveMembers |
| Lock | Deny Connect | Allow Connect+View | -- | -- |
| Unlock | Allow Connect | -- | -- | -- |
| Invisible | Deny View | Allow View | -- | -- |
| Visible | Allow View | -- | -- | -- |
| Close Chat | Deny SendMessages | Allow SendMessages | -- | -- |
| Open Chat | Allow SendMessages | -- | -- | -- |
| DND | Deny Speak/Stream/VAD/etc | -- | -- | -- |
| Block | -- | -- | Deny all voice+view+send | -- |

**Staff bypass**: Any member with `PermissionFlagsBits.Administrator` can use all control panel buttons on any temp channel, bypassing ownership checks (except Claim, which is only for non-owners). This is checked alongside the ownership check in every button handler.

---

## Implementation Phases

### Phase 1: Foundation
1. Add tables to `schema.js`
2. Create `tempvoiceService.js` (DB operations)
3. Create `contentFilter.js` (name validation)

### Phase 2: Core Logic
4. Create `tempvoiceEmbeds.js` (embed + buttons)
5. Create `tempvoiceManager.js` (orchestration, recovery, cleanup)

### Phase 3: User Interface
6. Create `tempvoiceButtons.js` (15 handlers)
7. Create `tempvoiceModals.js` (name + limit modals)
8. Create `tempvoice-setup.js` command

### Phase 4: Integration
9. Wire into `interactionCreate.js` (routing)
10. Wire into `voiceStateUpdate.js` (create/delete triggers)
11. Wire into `ready.js` (recovery + scheduler)
12. Wire into `index.js` (shutdown cleanup)

### Phase 5: Deploy & Test
13. `bun run deploy-commands`
14. Test: setup -> join-to-create -> all 15 buttons -> auto-delete -> restart recovery -> cleanup

---

## Verification Plan

1. Run `/tempvoice-setup` with trigger VC + category -> confirm DB row created
2. Join trigger VC -> confirm temp channel created, moved in, control panel sent
3. Test each of the 15 buttons (name, limit, privacy modes, dnd, region, trust/untrust, block/unblock, bitrate, invite, kick, claim, transfer, delete)
4. Leave channel empty -> confirm auto-deleted
5. Create 3 channels -> confirm 4th is rejected
6. Restart bot -> confirm channels recovered from DB
7. Leave channel inactive 24h+ -> confirm cleanup removes it
