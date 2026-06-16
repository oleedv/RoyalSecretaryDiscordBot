# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run start              # Start the bot
bun run dev                # Start with --watch (auto-reload on file changes)
bun run deploy-commands    # Register slash commands with Discord API
docker compose up --build  # Build and run via Docker
```

## Architecture

Royal Secretary is a Discord bot for the Royal Battalion gaming community, running on **Bun** with **discord.js v14** and **MariaDB**.

### Boot Sequence (`src/index.js`)
Validate config → create DB pools → test connections → create bot (load commands + events) → login → register shutdown hooks (SIGINT/SIGTERM).

### Handler Pattern
Commands and events are **auto-loaded** from their directories — drop a `.js` file in and it's registered automatically. No manual wiring.

**Commands** (`src/commands/*.js`) — default export with `{ data: SlashCommandBuilder, execute(interaction) }`:
```js
export default {
  data: new SlashCommandBuilder().setName('example').setDescription('...'),
  async execute(interaction) { /* ... */ },
};
```

**Events** (`src/events/*.js`) — default export with `{ name: Events.X, once: bool, execute(...args) }`.

**Handlers** (`src/handlers/*.js`) — feature-specific logic extracted from events. `interactionCreate.js` and `messageCreate.js` are thin routers that delegate to handler files by customId. New button/modal handlers go here with their customId registered in the routing map.

**Services** (`src/services/{feature}/`) — business logic grouped by domain (`ticket/`, `prospect/`). Each subdirectory splits into service (DB + orchestration), embeds (embed builders + components), and feature-specific files (voting, scheduling).

**Utilities** (`src/utils/`) — shared pure helpers: Discord helpers, permissions, panel management, attachment formatting, text command parsing, validation.

### Dual-Database Setup
The bot connects to two databases on the same external MariaDB server:
- `secretary` → `Royal_secretary` — bot's own data (full CRUD)
- `squadjs` → `SquadJS` — game server data (read-only)

Query with `query(sql, params, poolName)` where `poolName` defaults to `'secretary'`:
```js
import { query } from './database/connection.js';
await query('SELECT * FROM table WHERE id = ?', [id]);           // Royal_secretary
await query('SELECT * FROM players', [], 'squadjs');              // SquadJS
```

### Config Layering
- **`.env`** — secrets: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DB_HOST`, `DB_USER`, `DB_PASSWORD`
- **`settings.js`** — non-secrets: guild ID (`1143282481253077002`), channel IDs, role IDs (JS module with comments)

### Logging
Pino with child loggers per module. Pretty-print in dev (`NODE_ENV=development`), JSON in production.
```js
import logger from './logger.js';
const log = logger.child({ module: 'mymodule' });
```

## Conventions

- ESM only (`"type": "module"`) — use `import`/`export`, not `require`
- Always use parameterized queries (`?` placeholders) for database access
- Intents are explicit in `src/bot.js` — add new intents there when needed
- Guild-scoped command deployment when `config.guild.id` is set, otherwise global

## Seeding Config: Source of Truth

Two features share the word "seeding":

- **Seeding** (daily call + panel): `src/services/seeding/` — permanent panel with join-role button, scheduled daily-call post, live population monitor via SquadJS socket.io.
- **Seed Tracker** (reward): `src/services/seedTracker/` — tracks who helps seed, grants whitelist after N seed days in a rolling window, monthly leaderboard.

Each setting has exactly one home — don't duplicate:

| Setting | Master | Where | Editable from |
|---|---|---|---|
| `enabled`, `channel_id`, `role_ids`, `seed_threshold`, `reset_threshold`, `daily_time`, `timezone`, `panel_message_id`, `last_daily_call_date`, `last_reset_date`, `announcer_server_id`, `tracker_server_id`, `tracker_enabled`, `progression_channel_id`, `leaderboard_channel_id`, `required_seed_days`, `rolling_window_days`, `whitelist_duration_days`, `max_extension_days` | **DB** | `Royal_secretary.seeding_config` row id=1 | Website `/seeding` page |
| `seeding.schedulerCheckMs`, `seeding.default*` (first-insert defaults only) | **Repo** | `settings.{env}.js` | Code deploy |
| `SQUADJS_SERVERS` (name\|url\|token\|serverId per server), DB credentials, `NODE_ENV` | **Env var** | Container env | Deploy secret |

**Server identity**: `announcer_server_id` and `tracker_server_id` in the DB row are `squadjs_servers.id` values. The bot resolves them by matching the `serverId` field carried in each `SQUADJS_SERVERS` entry (4th field: `name|url|token|serverId`). There is **no fallback** to the first connection — an unresolved id or a disconnected socket yields an explicit "unavailable" state shown in Discord and on the website. The website server field is a validated dropdown of `squadjs_servers` rows, so a typo cannot occur.

Boot logs emit a single `[boot] bot environment` line with: `env`, `dbHost`, `squadjsServers` (name/url/serverId), `announcerServerId`, `trackerServerId`, `seedingChannelId`, `seedingRoleIds`, `seedThreshold`, `trackerEnabled`, `progressionChannelId`, `leaderboardChannelId` — check it after any deploy to verify the environment.
