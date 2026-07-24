# Royal Secretary

Discord bot for the **Royal Battalion** Squad gaming community. Runs tickets,
recruitment, seeding calls, activity analytics, verification, temporary voice
channels, game-server config monitoring, and live server status — all from a
single long-running process.

![Bun](https://img.shields.io/badge/Bun-runtime-f9f1e1?logo=bun&logoColor=000)
![discord.js](https://img.shields.io/badge/discord.js_v14-5865F2?logo=discord&logoColor=fff)
![MariaDB](https://img.shields.io/badge/MariaDB-003545?logo=mariadb)
![Pino](https://img.shields.io/badge/Pino-log-222)
![Claude AI](https://img.shields.io/badge/Claude_AI-d4a574?logo=anthropic&logoColor=000)
![Socket.IO](https://img.shields.io/badge/Socket.IO-client-010101?logo=socketdotio&logoColor=fff)

---

## Table of contents

- [Overview](#overview)
- [Architecture at a glance](#architecture-at-a-glance)
- [Interaction lifecycle](#interaction-lifecycle)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Boot sequence](#boot-sequence)
- [Auto-loading conventions](#auto-loading-conventions)
- [Database layer](#database-layer)
- [Configuration](#configuration)
- [Logging](#logging)
- [External integrations](#external-integrations)
- [Getting started](#getting-started)
- [Docker and deployment](#docker-and-deployment)
- [Extending the bot](#extending-the-bot)
- [Gotchas](#gotchas)
- [Conventions](#conventions)

---

## Overview

Royal Secretary is the authoritative back-office for a large Squad gaming
community. One Bun process connects to Discord over the gateway, holds two
MariaDB pools (its own data and a read-only SquadJS mirror), and opens
outbound connections to a handful of third-party services.

It exposes **no inbound HTTP surface**. Everything — slash commands, button
clicks, DMs, reactions, voice joins — arrives through the Discord gateway and
is dispatched through a thin event router into feature handlers and services.

Operational state lives in MariaDB. Transient data (voice sessions, cooldown
maps, socket connections) is kept in memory and rebuilt from the database on
startup.

---

## Architecture at a glance

```
                 ┌───────────────────────────────────────────┐
                 │             Discord Gateway               │
                 └─────────────────┬─────────────────────────┘
                                   │ WebSocket
                   ┌───────────────▼────────────────┐
                   │  src/bot.js  (discord.js v14)  │   auto-loads:
                   │  - intents + partials          │   - commands/*.js
                   │  - raw packet DM workaround    │   - events/*.js
                   └──┬─────────────────────────┬───┘
                      │                         │
             ┌────────▼────────┐       ┌────────▼─────────┐
             │ src/commands/   │       │  src/events/     │
             │ slash commands  │       │  thin routers    │
             └────────┬────────┘       └────────┬─────────┘
                      │                         │ customId / DM match
                      └──────────┬──────────────┘
                                 │
                       ┌─────────▼──────────┐
                       │  src/handlers/     │  per-feature interaction
                       │  buttons / modals  │  and message routers
                       │  / messages        │
                       └─────────┬──────────┘
                                 │
                       ┌─────────▼──────────┐
                       │  src/services/     │  business logic,
                       │  ticket/ prospect/ │  embeds, schedulers
                       │  seeding/ ...      │
                       └─┬──────────────┬───┘
                         │              │
              ┌──────────▼─────┐   ┌────▼───────────────────────┐
              │ src/database/  │   │      External services     │
              │  - secretary   │   │  BattleMetrics  Claude API │
              │  - squadjs (r) │   │  Steam          CBL        │
              │  - website (o) │   │  SFTP           SquadJS WS │
              └────────────────┘   └────────────────────────────┘
```

- `bot.js` owns the discord.js client and auto-loads the two flat
  directories underneath it.
- `events/` files are thin — they delegate to handlers by `customId` or
  DM/category match.
- `handlers/` know how to respond to a specific interaction; they call into
  `services/` for real work.
- `services/` hold domain logic, DB access, embed builders, and schedulers.
- `database/` exposes `query()` / `transaction()` against three MariaDB pools
  (one optional).

---

## Interaction lifecycle

Walking through a single click — *"staff hits Escalate on a ticket"* — makes
the layering concrete.

1. Discord delivers an `INTERACTION_CREATE` gateway packet with
   `customId: "ticket_escalate_admin"`.
2. `src/events/interactionCreate.js` is the registered listener. It looks up
   the customId in its static map and finds
   `ticketButtons.handleEscalate`.
3. The router enforces a 2-second per-user cooldown and wraps the call in a
   `safeReply` guard so a thrown error can never leave the user staring at a
   spinning interaction.
4. `src/handlers/ticketButtons.js:handleEscalate` runs. It reads the ticket
   row, validates the staff member's role tier, and calls
   `escalateTicket()` from `src/services/ticket/ticketService.js`.
5. The service updates the ticket row, moves the channel between
   categories, rebuilds the embed via `ticketEmbeds.js`, and writes an
   entry to `ticket_events` via `database/connection.js`.
6. Back in the handler, the new embed is rendered into the channel and an
   ephemeral confirmation is sent to the staff member.
7. The Pino logger emits a structured `info` event; it goes to the console
   and simultaneously to the `bot_logs` table via the DB log transport.

Every interaction follows this shape: **event → router → handler → service →
database (+ embed → channel)**.

---

## Features

Each feature is a folder under `src/services/`. Handler files under
`src/handlers/` wire interactions into them.

### Support tickets — `src/services/ticket/`
Five tiers (Normal, Community Officer, Admin Officer, Comp Team, Whitelist)
backed by private channels. Users DM the bot or click the panel to open one.
Text commands `!r`, `!close`, and `!logs` operate inside the ticket channel.
Closing enters a 2-hour grace window during which a user reply auto-reopens.
Full audit trail in `ticket_events`, anonymous replies, escalation between
tiers, paginated transcripts.

### Prospect recruitment — `src/services/prospect/`
Two-part application modal (personal info, then game experience), with
server-side validation of Steam ID, DOB, and Squad playtime. Mentors claim
applications; the community votes via reactions with a configurable deadline.
Claude evaluates the resume and player history. Acceptance assigns the team
role automatically.

### Squad seeding — `src/services/seeding/`
Real-time player count pulled from SquadJS over Socket.IO. A scheduler posts
a seeding call at a configured time; users opt in via buttons. Threshold
crossings (default 40 players) start sessions, <20 resets them. Multiple
SquadJS servers supported via `SQUADJS_SERVERS`.

### Seed tracker — `src/services/seedTracker/`
Monthly leaderboard, progression milestones, and whitelist-role rewards for
high contributors. Auto-renews at month rollover.

### Activity tracking — `src/services/activity/`
Voice sessions (duration, mute, deaf, stream, video) and message counts,
aggregated nightly into 30/60/90/365-day rolling windows. Voice sessions
recovered from the DB on restart. Staff can view any member; members see
only themselves.

### Temporary voice — `src/services/tempvoice/`
A trigger channel spawns a private voice room per user; the owner gets a
control panel (rename, limit, lock, transfer) via `tempvoiceButtons.js`. Name
filtering lives in `contentFilter.js`.

### Verification — `src/services/verify/`
Challenge-response flow behind a button on the entry panel. Correct answer
grants the verified role.

### Server status — `src/services/serverStatus/`
BattleMetrics API integration: live player counts, layer, and server info
posted to a status channel.

### Config Guardian — `src/services/configGuardian/`
Hourly SFTP poll of game-server config files. Line-by-line diff with
sensitive-value masking, posted to Discord on change, backups stored locally.

### Admin plumbing — `src/services/admin/`
- `statusHeartbeat.js` — uptime, latency, and DB health written to
  `bot_status` every 30s.
- `messageLogger.js` — full guild message history persisted.
- `logTransport.js` — Pino stream that persists info+ logs to `bot_logs`.
- `actionProcessor.js` — polls a queue table for actions dispatched by the
  companion web dashboard.

---

## Tech stack

| Component        | Technology              | Version |
|------------------|-------------------------|---------|
| Runtime          | Bun                     | latest  |
| Discord          | discord.js              | 14.16   |
| Database driver  | mariadb                 | 3.4     |
| AI               | @anthropic-ai/sdk       | 0.39    |
| Logging          | pino + pino-pretty      | 9.6     |
| Real-time        | socket.io-client        | 4.8     |
| SFTP             | ssh2-sftp-client        | 12.1    |
| Image processing | sharp                   | 0.34    |
| Diffing          | diff                    | 8.0     |
| Git              | simple-git              | 3.35    |

---

## Repository layout

```
.
├── src/
│   ├── index.js                     Boot: validate config -> pools -> schema -> login
│   ├── bot.js                       Client, intents, auto-loaders, raw-packet DM fix
│   ├── config.js                    Merges .env secrets with settings.{env}.js
│   ├── logger.js                    Pino multistream (console + DB)
│   │
│   ├── database/
│   │   ├── connection.js            Pools, query(), transaction()
│   │   └── schema.js                DDL + forward migrations
│   │
│   ├── commands/                    Slash commands (auto-loaded)
│   ├── events/                      Discord event listeners (auto-loaded)
│   ├── handlers/                    Per-feature button / modal / message routers
│   ├── services/                    Domain logic per feature (see Features above)
│   └── utils/                       Shared pure helpers (embeds, permissions, ids)
│
├── settings.js                      Loader that picks settings.{NODE_ENV}.js
├── settings.development.js          Dev guild/channel/role IDs
├── settings.staging.js              Staging guild/channel/role IDs
├── settings.production.js           Production guild/channel/role IDs
├── .env.example                     Secret template (see Configuration)
│
├── Dockerfile                       oven/bun:latest, non-root user
├── docker-compose.yml               Local compose (bot + MariaDB)
└── .github/workflows/
    ├── deploy-staging.yml           main -> staging server
    └── deploy-production.yml        production -> prod server
```

---

## Boot sequence

`src/index.js` performs these steps, in order; any failure in the first four
is fatal:

1. Validate required env vars (`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DB_*`).
2. Create MariaDB pools (secretary, squadjs, optional website).
3. Ping every pool. Secretary failure aborts boot; website failure degrades.
4. Run `initSchema()` — creates tables and applies forward migrations.
5. `createBot()` — build the `Client` with explicit intents and partials,
   install the raw-packet DM workaround, and auto-load `commands/` +
   `events/`.
6. `client.login(token)`.
7. Print the startup banner with loaded counts and DB status.
8. Register `SIGINT` / `SIGTERM` handlers that stop schedulers, flush logs,
   close pools, and destroy the client.

---

## Auto-loading conventions

Drop a file in, it gets registered. No manual wiring.

**Command** — `src/commands/example.js`:

```js
import { SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder().setName('example').setDescription('...'),
  async execute(interaction) { /* ... */ },
};
```

Register with Discord via `bun run deploy-commands` (guild-scoped when
`config.guild.id` is set, otherwise global).

**Event** — `src/events/guildMemberAdd.js`:

```js
import { Events } from 'discord.js';

export default {
  name: Events.GuildMemberAdd,
  async execute(member) { /* ... */ },
};
```

Set `once: true` for one-shot listeners.

**Handler** — interaction routing happens in
`src/events/interactionCreate.js`, which maps `customId` to handler
functions:

```js
const buttonHandlers = {
  ticket_create: ticketButtons.handleCreate,
  ticket_escalate_admin: ticketButtons.handleEscalate,
  // ...
};
```

The handler itself lives in `src/handlers/<feature>Buttons.js`:

```js
export async function handleEscalate(interaction) {
  const ticket = await getTicketForChannel(interaction.channelId);
  await escalateTicket(ticket, interaction.member);
  await interaction.reply({ content: 'Escalated.', flags: ['Ephemeral'] });
}
```

Dynamic customIds (e.g. `logs_prev:<ticketId>`,
`verify_answer_<questionId>`) use pattern matching after the static-map
lookup misses.

---

## Database layer

Three pools against the same MariaDB server. All queries are parameterised;
there is no ORM.

| Pool        | Database              | Access    | Purpose                     |
|-------------|-----------------------|-----------|-----------------------------|
| `secretary` | `Royal_secretary*`    | Full CRUD | Bot's own tables            |
| `squadjs`   | `SquadJS`             | Read-only | Shared game-server data     |
| `website`   | `royal_battalion*`    | Read-only | Optional; disabled on fail  |

```js
import { query, transaction } from './database/connection.js';

// Defaults to the secretary pool.
await query('SELECT * FROM tickets WHERE id = ?', [id]);

// Explicit pool.
await query('SELECT * FROM players WHERE steam_id = ?', [steamId], 'squadjs');

// Transactions.
await transaction(async (conn) => {
  await conn.query('INSERT INTO prospects (...) VALUES (?, ?)', [a, b]);
  await conn.query('INSERT INTO prospect_events (...) VALUES (?, ?)', [c, d]);
}, 'secretary');
```

DDL and forward migrations live in `src/database/schema.js` and run on
startup.

---

## Configuration

Two layers — secrets in `.env`, everything else in environment-specific
JavaScript modules.

### Secrets — `.env`

`settings.js` picks `settings.${NODE_ENV}.js` (defaulting to `staging`). Copy
`.env.example` to `.env` and populate the core variables:

| Variable               | Required | Purpose                                       |
|------------------------|----------|-----------------------------------------------|
| `DISCORD_TOKEN`        | yes      | Bot token from the Discord developer portal   |
| `DISCORD_CLIENT_ID`    | yes      | Application client ID (used for deployment)   |
| `DB_HOST` / `DB_PORT`  | yes      | MariaDB host / port (port defaults to 3306)   |
| `DB_USER` / `DB_PASSWORD` | yes   | MariaDB credentials                           |
| `DB_NAME`              | yes      | Secretary database name                       |
| `WEBSITE_DB_NAME`      | no       | Enables the optional website pool             |
| `NODE_ENV`             | yes      | `development` / `staging` / `production`      |
| `LOG_FORMAT`           | no       | `pretty` (dev) or JSON (prod default)         |
| `LOG_LEVEL`            | no       | Pino level override                           |
| `SQUADJS_SERVERS`      | no       | `name\|ws://host:port\|token\|serverId`, comma-separated (`serverId` = `squadjs_servers.id`; required for multi-server status stats) |
| `ANTHROPIC_API_KEY`    | no       | Enables Claude features                       |

Feature-specific secrets (BattleMetrics, Steam, SFTP, Git) are read from
`process.env` at the point of use; set only what you need. See
`src/config.js` for the full consolidated shape.

### Non-secrets — `settings.{env}.js`

Per-environment files hold Discord IDs (guild, channels, roles) and feature
toggles (ticket categories, seeding thresholds, BattleMetrics server ID).
Edit the file matching your `NODE_ENV`, **not** `settings.js` itself — the
latter is just a loader.

---

## Logging

Pino with a multistream transport:

- **Console** — pretty-printed when `LOG_FORMAT=pretty` (dev), JSON
  otherwise (prod).
- **Database** — `info`+ records streamed to the `bot_logs` table via
  `src/services/admin/logTransport.js`. Flushed on shutdown.

Child loggers carry a `module` tag:

```js
import logger from './logger.js';
const log = logger.child({ module: 'tickets' });
log.info({ ticketId }, 'escalated');
```

Level defaults to `info`; override with `LOG_LEVEL`.

---

## External integrations

Everything is outbound. The bot opens no listening sockets.

| Service              | Protocol / SDK           | Purpose                              | Primary file                                     |
|----------------------|--------------------------|--------------------------------------|--------------------------------------------------|
| Discord              | discord.js gateway       | Bot runtime                          | `src/bot.js`                                     |
| BattleMetrics        | REST                     | Server status, player flags, bans    | `src/services/battlemetricsService.js`           |
| Community Ban List   | GraphQL                  | Cross-community ban checks           | `src/services/cblService.js`                     |
| Steam                | REST                     | Steam ID / vanity URL resolution     | `src/services/steamService.js`                   |
| Anthropic Claude     | `@anthropic-ai/sdk`      | Prospect evaluation, ticket AI hints | `src/services/ai/anthropicClient.js`             |
| SquadJS              | Socket.IO client         | Live player / layer updates          | `src/services/seeding/seedingSocket.js`          |
| Game-server SFTP     | `ssh2-sftp-client`       | Config-file monitoring               | `src/services/configGuardian/configGuardianService.js` |
| MariaDB              | `mariadb` pool           | Persistence                          | `src/database/connection.js`                     |

---

## Getting started

### Prerequisites

- [Bun](https://bun.sh)
- MariaDB server (local, Docker, or remote)
- A Discord application with a bot user and a test guild

### Local dev

```bash
bun install
cp .env.example .env        # fill in DISCORD_TOKEN, DB_*, NODE_ENV=development
```

Edit `settings.development.js` with the IDs of your test guild, channels,
and roles. Then:

```bash
bun run deploy-commands      # registers slash commands with Discord
bun run dev                  # starts the bot with --watch
```

If you need a local database, `docker compose up -d mariadb` brings one up
and pre-creates the required schemas.

---

## Docker and deployment

Local build:

```bash
docker compose up --build
```

The `Dockerfile` uses `oven/bun:latest`, runs as a non-root `botuser`, and
bundles `settings.staging.js` / `settings.production.js` (development
settings are intentionally excluded from the image).

### CI/CD

GitHub Actions handle environment promotion:

| Branch       | Workflow                              | Target   |
|--------------|---------------------------------------|----------|
| `main`       | `.github/workflows/deploy-staging.yml`    | Staging  |
| `production` | `.github/workflows/deploy-production.yml` | Prod     |

Each workflow builds the image, pushes it to GHCR, and triggers a pull +
restart on the VPS via SSH. The production `docker-compose.{staging,prod}.yml`
files live on the server, not in this repo.

---

## Extending the bot

### Add a slash command

1. Create `src/commands/my-command.js` (see [Auto-loading](#auto-loading-conventions)).
2. `bun run deploy-commands`.

### Add an event listener

Drop a file in `src/events/` — it's picked up on next start.

### Add a button or modal handler

1. Add the handler function to a file under `src/handlers/`.
2. Register its `customId` in the router map in
   `src/events/interactionCreate.js`. Use a static entry for a fixed
   customId, or a pattern check for dynamic ones (`prefix:<id>`).

### Add a database table or migration

Edit `src/database/schema.js` — add the `CREATE TABLE IF NOT EXISTS`
statement and any `ALTER` guard for forward migrations. Changes run on the
next boot.

---

## Gotchas

- **Uncached DM workaround.** `src/bot.js` installs a `raw` gateway listener
  that re-emits `MESSAGE_CREATE` when discord.js silently drops events for
  uncached DM channels. The DM relay features (tickets, prospects) depend
  on it. Do not remove.
- **Ticket close is not final.** Closing a ticket starts a two-hour grace
  window during which a user reply auto-reopens it. Use the `force_close`
  button to end it immediately.
- **Partial in-memory state.** Voice sessions, cooldowns, anonymous-mode
  toggles, and socket connections live in memory. The bot rebuilds what it
  can from the DB in the `ready` event on restart; anything without DB
  persistence is lost.
- **Dynamic customIds.** The router does static-map lookup first, then
  pattern matching. If a new button uses a `prefix:<id>` pattern, add the
  pattern branch in `interactionCreate.js`.
- **`SQUADJS_SERVERS` is pipe-delimited, comma-separated.** One connection
  per segment: `production|ws://host:port|token|1,battle|ws://...|token|2`.
  The 4th field is `squadjs_servers.id` and is required for multi-server
  (each status embed must query its own TPS / new-players stats).
- **`settings.js` is a loader, not config.** Edit the file matching your
  `NODE_ENV` (`settings.development.js` / `settings.staging.js` /
  `settings.production.js`).
- **No inbound HTTP.** The bot does not expose a webhook or health-check
  endpoint. Health signal is the heartbeat row in `bot_status`.

---

## Conventions

- **ESM only** (`"type": "module"`) — `import` / `export`, never `require`.
- **Parameterised SQL** (`?` placeholders) for every query.
- **Conventional commits** (`feat:`, `fix:`, `chore:` …), one-line messages.
- **File names** are kebab-case; identifiers are camelCase;
  constants UPPER_SNAKE_CASE.
- Explicit intents in `src/bot.js` — add new ones there when needed.
- No TypeScript; use JSDoc where typing is load-bearing.
- No emojis in code, commit messages, or generated content.
