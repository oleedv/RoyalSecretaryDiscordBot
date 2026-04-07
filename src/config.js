import settings from '../settings.js';

const requiredEnvVars = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];

export function validateConfig() {
  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function parseSquadJsServers(envStr) {
  if (!envStr) return [];
  return envStr.split(',').map((entry) => {
    const [name, url, token] = entry.trim().split('|');
    return { name, url, token };
  });
}

const config = Object.freeze({
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
  },
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
  },
  database: {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    databases: {
      secretary: process.env.DB_NAME,
      squadjs: 'SquadJS',
      website: process.env.WEBSITE_DB_NAME,
    },
  },
  squadjs: parseSquadJsServers(process.env.SQUADJS_SERVERS),
  ...settings,
  // Merge env vars with settings.battlemetrics (explicit key overrides spread above)
  battlemetrics: {
    token: process.env.BM_TOKEN,
    serverId: process.env.BM_SERVER_ID,
    ...settings.battlemetrics,
  },
});

export default config;
