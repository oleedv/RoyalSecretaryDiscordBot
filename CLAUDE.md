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
