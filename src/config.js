import settings from '../settings.js';

const requiredEnvVars = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DB_HOST', 'DB_USER', 'DB_PASSWORD'];

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
      secretary: process.env.DB_NAME || 'Royal_secretary_staging',
      squadjs: 'SquadJS',
    },
  },
  squadjs: parseSquadJsServers(process.env.SQUADJS_SERVERS),
  ...settings,
});

export default config;
