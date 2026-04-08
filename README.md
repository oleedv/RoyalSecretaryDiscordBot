# Royal Secretary

Discord bot for the **Royal Battalion** gaming community. Handles support tickets, prospect recruitment, seeding coordination, activity tracking, server monitoring, and more.

Built on [Bun](https://bun.sh), [discord.js v14](https://discord.js.org), and [MariaDB](https://mariadb.org).

![Bun](https://img.shields.io/badge/Bun-runtime-f9f1e1?logo=bun&logoColor=000)
![discord.js](https://img.shields.io/badge/discord.js_v14-5865F2?logo=discord&logoColor=fff)
![MariaDB](https://img.shields.io/badge/MariaDB-003545?logo=mariadb)
![Claude AI](https://img.shields.io/badge/Claude_AI-d4a574?logo=anthropic&logoColor=000)

## Features

### Support Tickets
- Five ticket tiers: Normal, Community Officer, Admin Officer, Comp Team, Whitelist
- DM relay between users and staff in private channels
- Escalation between tiers
- Text commands: `!r` (reply), `!close`, `!logs` (paginated transcript)
- Auto-closing with configurable timeouts
- Reopen, force close, and anonymous ticket options
- Full audit trail of ticket events

### Prospect Recruitment
- Two-part application form (personal info, then game experience)
- Auto-validation of Steam ID, date of birth, and Squad playtime hours
- AI-powered resume analysis via Claude
- Mentor assignment and staff claim/unclaim system
- Community voting with yes/no/unsure options and optional reasons
- 14-day vote deadlines with extension support
- Accept/deny workflows with detailed responses
- DM relay between prospects and staff
- Team role auto-assignment on acceptance

### Squad Seeding Coordination
- Real-time player count from SquadJS via WebSocket
- Daily seeding call scheduling at configurable times
- Join/leave button tracking with session state management
- Map/layer tracking and peak player count updates
- Threshold-based triggers for seeding and reset events

### Seed Tracker
- Track seeding session duration and completion
- Monthly leaderboards with progression milestones
- Whitelist role rewards for active seeders
- Auto-extension for high contributors

### Activity Tracking
- Discord voice session metrics: duration, mute, deaf, stream, and video time
- Message activity counts per channel (daily aggregation)
- Reaction tracking
- Multi-period summaries (30, 60, 90, 365 days)
- Staff can view any member; non-staff see their own stats only
- Voice state recovery on bot restart

### Config Guardian
- SFTP monitoring of remote game server configuration files
- Automatic diff detection with line-by-line change visualization
- Sensitive value masking in change reports
- Hourly polling with deleted file detection
- Change notifications posted to Discord

### Server Status
- BattleMetrics API integration for real-time server info
- Player counts, map/layer data, and server metrics
- Scheduled status updates in Discord channels

### Verification
- Challenge-response verification flow
- Automatic role assignment on success
- Self-maintaining panel embeds

### AI Integration
- Claude API for ticket assistance and context summarization
- Prospect application analysis and resume evaluation

### Admin Tools
- **Status Heartbeat** -- bot uptime, member count, latency, DB connection status
- **Message Logging** -- all incoming and outgoing messages persisted to database
- **Action Queue** -- processes pending actions from the web dashboard
- **Log Transport** -- Pino log persistence for operational visibility

## Architecture

### Boot Sequence
Validate config -> create DB pools -> test connections -> create bot (load commands + events) -> login -> register shutdown hooks.

### Handler Pattern
Commands and events are auto-loaded from their directories. `interactionCreate.js` and `messageCreate.js` are thin routers that delegate to handler files by `customId`.

### Dual-Database Setup
- **`Royal_secretary`** -- bot's own data (full CRUD)
- **`SquadJS`** -- game server data (read-only)

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Bun | latest |
| Discord | discord.js | 14.16 |
| Database | MariaDB | 3.4 |
| AI | Anthropic Claude SDK | latest |
| Logging | Pino | 9.6 |
| Image Processing | Sharp | 0.34 |
| Real-time | Socket.IO Client | 4.8 |
| SFTP | ssh2-sftp-client | 12.1 |
| Git Operations | simple-git | 3.35 |

## Project Structure

```
src/
├── index.js                     # Boot: validate config, DB pools, login, shutdown hooks
├── bot.js                       # Client setup, auto-loads commands + events
├── config.js                    # Merges .env secrets with settings.js
├── logger.js                    # Pino logger (pretty in dev, JSON in prod)
│
├── database/
│   ├── connection.js            # Dual pool (secretary + squadjs) + query()
│   └── schema.js                # Table creation + migrations
│
├── commands/                    # Slash commands (auto-loaded)
│   ├── ping.js
│   ├── ticket-setup.js
│   ├── prospect-setup.js
│   └── activity.js
│
├── events/                      # Discord event listeners (auto-loaded)
│   ├── ready.js                 # Panel checks + scheduler start
│   ├── interactionCreate.js     # Thin router -> handlers/
│   ├── messageCreate.js         # Thin router -> handlers/
│   ├── messageUpdate.js         # DM edit tracking
│   ├── messageReactionAdd.js    # Prospect voting
│   ├── messageReactionRemove.js # Prospect vote removal
│   ├── guildMemberRemove.js     # Purged member tracking
│   ├── guildMemberUpdate.js     # Role updates
│   └── voiceStateUpdate.js      # Activity tracking
│
├── handlers/                    # Interaction/message routing by feature
│   ├── ticketButtons.js         # Create modal, escalate, close, reopen, logs
│   ├── ticketModals.js          # Ticket creation & quick ticket
│   ├── ticketMessages.js        # DM relay + !r, !close, !logs
│   ├── prospectButtons.js       # Apply, claim, accept, deny, vote, extend
│   ├── prospectModals.js        # Two-part form, deny, extend modals
│   ├── prospectMessages.js      # DM relay + !r, !close
│   ├── seedingButtons.js        # Join/leave seeding calls
│   ├── seedTrackerButtons.js    # Progression tracking
│   ├── verifyButtons.js         # Verification flow
│   ├── activityButtons.js       # Activity stats tabs
│   └── memberLeave.js          # Purged member handling
│
├── services/                    # Business logic + DB operations
│   ├── ticket/                  # Support ticket system
│   ├── prospect/                # Recruitment and voting
│   ├── seeding/                 # Squad seeding coordination
│   ├── seedTracker/             # Seeding progression tracking
│   ├── activity/                # Discord activity metrics
│   ├── ai/                      # Claude AI integration
│   ├── configGuardian/          # SFTP config file monitoring
│   ├── serverStatus/            # BattleMetrics server monitoring
│   ├── verify/                  # Member verification
│   ├── purged/                  # Purged member tracking
│   ├── admin/                   # Status heartbeat, logging, action queue
│   ├── battlemetricsService.js  # BattleMetrics API
│   ├── cblService.js            # Community Ban List
│   ├── steamService.js          # Steam ID validation
│   ├── playtimeService.js       # Playtime fetching
│   ├── whitelistService.js      # Whitelist management
│   └── userService.js           # User profile data
│
└── utils/                       # Shared utilities
    ├── embed.js                 # Base embed factory
    ├── deploy-commands.js       # Slash command registration
    ├── discord.js               # Discord helpers
    ├── permissions.js           # Channel permissions
    ├── panelManager.js          # Generic panel ensuring
    ├── messageSearch.js         # Message finding
    ├── attachments.js           # Attachment formatting
    ├── commands.js              # Text command parsing
    ├── modalComponents.js       # Modal builders
    ├── validation.js            # Input validation
    └── countries.js             # Country lists
```

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) runtime
- MariaDB server (local or remote)
- Discord bot token + application

### Setup

1. **Install dependencies**

   ```bash
   bun install
   ```

2. **Configure secrets** -- copy `.env.example` to `.env` and fill in:

   ```
   DISCORD_TOKEN=your-bot-token
   DISCORD_CLIENT_ID=your-app-client-id
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=secret
   ```

3. **Configure settings** -- edit `settings.js` for guild ID, channel IDs, role IDs, and feature config. These are non-secret values specific to your Discord server.

4. **Register slash commands**

   ```bash
   bun run deploy-commands
   ```

5. **Start the bot**

   ```bash
   bun run start        # Production
   bun run dev          # Development (auto-reload)
   ```

### Docker

```bash
docker compose up --build
```

## Adding New Features

### Slash command

Create `src/commands/my-command.js`:

```js
import { SlashCommandBuilder } from 'discord.js'

export default {
  data: new SlashCommandBuilder()
    .setName('my-command')
    .setDescription('Does something'),

  async execute(interaction) {
    await interaction.reply('Hello!')
  },
}
```

Then run `bun run deploy-commands` to register it.

### Event listener

Create `src/events/myEvent.js`:

```js
import { Events } from 'discord.js'

export default {
  name: Events.GuildMemberAdd,
  async execute(member) {
    // handle event
  },
}
```

Auto-loaded on next startup.

### Button/modal handler

1. Add the handler function to the appropriate file in `src/handlers/`
2. Register the `customId` in the routing map in `src/events/interactionCreate.js`

### Database queries

```js
import { query } from './database/connection.js'

// Royal_secretary DB (default)
await query('SELECT * FROM tickets WHERE id = ?', [id])

// SquadJS DB (read-only)
await query('SELECT * FROM players', [], 'squadjs')
```

Always use parameterized queries (`?` placeholders).
