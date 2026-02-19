# Royal Secretary

Discord bot for the **Royal Battalion** gaming community. Handles support tickets and prospect (recruitment) applications with DM relay, staff workflows, and community voting.

Built on [Bun](https://bun.sh), [discord.js v14](https://discord.js.org), and [MariaDB](https://mariadb.org).

## Prerequisites

- [Bun](https://bun.sh) runtime
- MariaDB server (local or remote)
- Discord bot token + application

## Setup

1. **Install dependencies**

   ```bash
   bun install
   ```

2. **Configure secrets** — copy `.env.example` to `.env` and fill in:

   ```
   DISCORD_TOKEN=your-bot-token
   DISCORD_CLIENT_ID=your-app-client-id
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=secret
   ```

3. **Configure settings** — edit `settings.js` for guild ID, channel IDs, role IDs, and prospect period config. These are non-secret values specific to your Discord server.

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
│   └── prospect-setup.js
│
├── events/                      # Discord event listeners (auto-loaded)
│   ├── ready.js                 # Panel checks + scheduler start
│   ├── interactionCreate.js     # Thin router → handlers/
│   ├── messageCreate.js         # Thin router → handlers/
│   ├── messageUpdate.js         # DM edit tracking
│   ├── messageReactionAdd.js    # Prospect voting
│   └── messageReactionRemove.js # Prospect vote removal
│
├── handlers/                    # Interaction/message routing by feature
│   ├── ticketButtons.js         # Create modal, escalate, close
│   ├── ticketModals.js          # Ticket creation modal submission
│   ├── ticketMessages.js        # DM relay + !r, !close, !logs
│   ├── prospectButtons.js       # Apply, claim, accept, deny, pause, extend, vote
│   ├── prospectModals.js        # Two-part form, deny, extend modals
│   └── prospectMessages.js      # DM relay + !r, !close
│
├── services/                    # Business logic + DB operations
│   ├── ticket/
│   │   ├── ticketService.js     # CRUD, escalation, message saving
│   │   ├── ticketPanel.js       # Panel embed + auto-ensure
│   │   └── ticketEmbeds.js      # Info embed + button components
│   ├── prospect/
│   │   ├── prospectService.js   # CRUD, claim, accept, close, pause, extend
│   │   ├── prospectVoting.js    # Vote posting, upsert, removal
│   │   ├── prospectPanel.js     # Panel embed + auto-ensure
│   │   ├── prospectEmbeds.js    # Info, forum, vote embeds + components
│   │   └── prospectScheduler.js # Hourly vote check
│   └── steamService.js          # Steam ID validation + detection
│
└── utils/                       # Shared utilities
    ├── embed.js                 # Base embed factory
    ├── deploy-commands.js       # Slash command registration
    ├── discord.js               # getUserTag, sendDM, ensurePartialFetched, trySendWithFiles
    ├── permissions.js           # buildPrivateChannelPermissions
    ├── panelManager.js          # Generic ensurePanel
    ├── messageSearch.js         # findBotMessageByCustomId
    ├── attachments.js           # formatForDb, applyAttachments
    ├── commands.js              # parseTextCommand (!r, !close, !logs)
    └── validation.js            # validateDateOfBirth, validateSquadHours
```

## Adding New Features

### New slash command

Create `src/commands/my-command.js`:

```js
import { SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('my-command')
    .setDescription('Does something'),

  async execute(interaction) {
    await interaction.reply('Hello!');
  },
};
```

Then run `bun run deploy-commands` to register it.

### New event listener

Create `src/events/myEvent.js`:

```js
import { Events } from 'discord.js';

export default {
  name: Events.GuildMemberAdd,
  async execute(member) {
    // handle event
  },
};
```

It will be auto-loaded on next startup.

### New button/modal handler

1. Add the handler function to the appropriate file in `src/handlers/`
2. Register the `customId` in the routing map in `src/events/interactionCreate.js`

### Database queries

```js
import { query } from './database/connection.js';

// Royal_secretary DB (default)
await query('SELECT * FROM tickets WHERE id = ?', [id]);

// SquadJS DB (read-only)
await query('SELECT * FROM players', [], 'squadjs');
```

Always use parameterized queries (`?` placeholders).
