import { io } from 'socket.io-client';
import config from '../../config.js';
import logger from '../../logger.js';
import { isRosterStale } from './seedingHealth.js';
import { pickServerStateById, coerceServerId } from './serverResolver.js';
import { shouldLogReconnectAttempt } from '../../utils/reconnectLog.js';

const log = logger.child({ module: 'seedingSocket' });

const ACK_TIMEOUT_MS = 5000;
const ROSTER_STALE_MS = 120_000;

const connections = new Map(); // name -> { socket, state }
let discordClient = null;
let watchdogInterval = null;

let announcerServerId = null; // set by the scheduler from DB config each tick
export function setAnnouncerServerId(id) { announcerServerId = coerceServerId(id); }
export function getAnnouncerServerId() { return announcerServerId; }

const KNOWN_EVENTS = [
  'UPDATED_A2S_INFORMATION', 'UPDATED_PLAYER_INFORMATION',
  'UPDATED_LAYER_INFORMATION', 'NEW_GAME',
  'PLAYER_CONNECTED', 'PLAYER_DISCONNECTED',
  'SEED_SESSION_COMPLETE', 'SEED_MILESTONE',
];

function createState() {
  return {
    playerCount: 0,
    currentMap: null,
    currentLayer: null,
    serverName: null,
    connected: false,
    players: [],
    publicSlots: 0,
    reserveSlots: 0,
    publicQueue: 0,
    reserveQueue: 0,
    gameVersion: null,
    currentLayerObj: null,
    lastEventTime: Date.now(),
    lastPlayersOk: 0,
    reconnectErrorCount: 0,
  };
}

// Extract map name from layer string, e.g. "Mutaha_Seed_v1" -> "Mutaha"
function extractMapName(layerName) {
  if (!layerName) return null;
  if (typeof layerName !== 'string') layerName = layerName.name ?? String(layerName);
  const normalized = layerName.replace(/\s+/g, '_');
  const match = normalized.match(/^(.+?)_(?:AAS|RAAS|Invasion|Insurgency|Seed|Skirmish|TC|TA|Destruction)_/i);
  return match ? match[1].replace(/_/g, ' ') : layerName.split('_')[0];
}

function fetchPlayers(conn) {
  if (!conn.socket?.connected) return;
  conn.socket.timeout(ACK_TIMEOUT_MS).emit('players', (err, data) => {
    if (err) {
      log.warn({ name: conn.name }, 'players ack timed out');
      return;
    }
    conn.state.lastEventTime = Date.now();
    if (Array.isArray(data)) {
      conn.state.players = data;
      conn.state.lastPlayersOk = Date.now();
      log.debug({ name: conn.name, count: data.length }, 'Fetched player list');
    }
  });
}

function fetchLayerObj(conn) {
  if (!conn.socket?.connected) return;
  conn.socket.timeout(ACK_TIMEOUT_MS).emit('currentLayer', (err, data) => {
    if (err) {
      log.warn({ name: conn.name }, 'currentLayer ack timed out');
      return;
    }
    conn.state.lastEventTime = Date.now();
    if (data) {
      conn.state.currentLayerObj = data;
      log.debug({ name: conn.name, layer: data.name }, 'Fetched layer object');
    }
  });
}

function connectServer(serverCfg) {
  const conn = { socket: null, state: createState(), name: serverCfg.name, serverId: serverCfg.serverId ?? null };
  connections.set(serverCfg.name, conn);

  log.info({ name: serverCfg.name, url: serverCfg.url }, 'Connecting to SquadJS');

  conn.socket = io(serverCfg.url, {
    auth: { token: serverCfg.token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionDelayMax: 30000,
    reconnectionAttempts: Infinity,
    timeout: 10000,
  });

  conn.socket.on('connect', () => {
    if (conn.state.reconnectErrorCount > 0) {
      log.info({ name: serverCfg.name, attempts: conn.state.reconnectErrorCount }, 'Reconnected to SquadJS');
    } else {
      log.info({ name: serverCfg.name }, 'Connected to SquadJS');
    }
    conn.state.reconnectErrorCount = 0;
    conn.state.connected = true;
    conn.state.lastEventTime = Date.now();
    conn.state.lastPlayersOk = Date.now(); // grace window; updated on first successful fetch
    // Pull the live roster + layer immediately rather than waiting for the next broadcast.
    fetchPlayers(conn);
    fetchLayerObj(conn);
  });

  conn.socket.on('disconnect', (reason) => {
    const wasConnected = conn.state.connected;
    conn.state.connected = false;
    if (wasConnected) {
      log.warn({ name: serverCfg.name, reason }, 'Disconnected from SquadJS');
    }
    if (reason === 'io server disconnect') {
      log.info({ name: serverCfg.name }, 'Server-initiated disconnect, reconnecting in 5s...');
      setTimeout(() => conn.socket.connect(), 5000);
    }
  });

  conn.socket.on('connect_error', (err) => {
    conn.state.reconnectErrorCount++;
    if (shouldLogReconnectAttempt(conn.state.reconnectErrorCount)) {
      const payload = { name: serverCfg.name, attempt: conn.state.reconnectErrorCount, err: err.message };
      if (conn.state.reconnectErrorCount === 1) {
        log.error(payload, 'SquadJS connection error');
      } else {
        log.warn(payload, 'Still reconnecting to SquadJS');
      }
    }
  });

  conn.socket.on('UPDATED_A2S_INFORMATION', (data) => {
    const s = conn.state;
    s.playerCount = data.a2sPlayerCount ?? data.playerCount ?? s.playerCount;
    const a2sLayer = data.currentLayer ?? s.currentLayer;
    s.currentLayer = typeof a2sLayer === 'string' ? a2sLayer : a2sLayer?.name ?? s.currentLayer;
    s.currentMap = extractMapName(s.currentLayer);
    s.serverName = data.serverName ?? s.serverName;
    s.publicSlots = data.maxPlayers != null && data.reserveSlots != null
      ? data.maxPlayers - data.reserveSlots
      : s.publicSlots;
    s.reserveSlots = data.reserveSlots ?? s.reserveSlots;
    s.publicQueue = data.publicQueue ?? s.publicQueue;
    s.reserveQueue = data.reserveQueue ?? s.reserveQueue;
    s.gameVersion = data.gameVersion ?? s.gameVersion;
    log.debug({ name: serverCfg.name, playerCount: s.playerCount, layer: s.currentLayer }, 'A2S update');
    fetchPlayers(conn);
    fetchLayerObj(conn);
  });

  conn.socket.on('UPDATED_PLAYER_INFORMATION', () => fetchPlayers(conn));
  conn.socket.on('UPDATED_LAYER_INFORMATION', () => fetchLayerObj(conn));

  conn.socket.on('NEW_GAME', (data) => {
    const newLayer = data.currentLayer ?? data.layer ?? conn.state.currentLayer;
    conn.state.currentLayer = typeof newLayer === 'string' ? newLayer : newLayer?.name ?? conn.state.currentLayer;
    conn.state.currentMap = extractMapName(conn.state.currentLayer);
    conn.state.playerCount = 0;
    log.info({ name: serverCfg.name, map: conn.state.currentMap, layer: conn.state.currentLayer }, 'New game started');

    // The live layer just changed; re-render the rotation embed so its
    // current-map highlight + match timer track the new round.
    const connServerId = coerceServerId(conn.serverId);
    if (discordClient && connServerId != null && connServerId === announcerServerId) {
      import('../layerRotationValidator/layerRotationValidatorScheduler.js')
        .then(({ refreshLiveLayerHighlight }) => refreshLiveLayerHighlight(discordClient))
        .catch((err) => log.error({ err }, 'Failed to refresh layer rotation highlight on NEW_GAME'));
    }
  });

  conn.socket.on('PLAYER_CONNECTED', () => {
    conn.state.playerCount++;
  });

  conn.socket.on('PLAYER_DISCONNECTED', () => {
    conn.state.playerCount = Math.max(0, conn.state.playerCount - 1);
  });

  conn.socket.on('SEED_SESSION_COMPLETE', (data) => {
    log.info({ name: serverCfg.name, steamId: data?.steamID, player: data?.playerName }, 'Seed session complete event');
    if (discordClient && data) {
      import('../seedTracker/seedTrackerService.js').then(({ processCompletedSession }) => {
        processCompletedSession(data, discordClient).catch((err) => {
          log.error({ err }, 'Failed to process seed session complete');
        });
      });
    }
  });

  conn.socket.on('SEED_MILESTONE', (data) => {
    log.info({ name: serverCfg.name, steamId: data?.steamID, milestone: data?.milestone }, 'Seed milestone event');
    if (discordClient && data) {
      import('../seedTracker/seedTrackerService.js').then(({ processMilestone }) => {
        processMilestone(data, discordClient).catch((err) => {
          log.error({ err }, 'Failed to process seed milestone');
        });
      });
    }
  });

  conn.socket.onAny((event, data) => {
    conn.state.lastEventTime = Date.now();
    if (!KNOWN_EVENTS.includes(event)) {
      log.debug({ name: serverCfg.name, event, dataKeys: data ? Object.keys(data) : null }, 'SquadJS event');
    }
  });
}

export function connect(client) {
  if (client) discordClient = client;
  const servers = config.squadjs;
  if (process.env.SQUADJS_DISABLED) {
    log.info({ disabled: process.env.SQUADJS_DISABLED }, 'Skipping disabled SquadJS server(s)');
  }
  if (!servers?.length) {
    log.warn('No SquadJS server configured (SQUADJS_SERVERS env var missing, or all names listed in SQUADJS_DISABLED)');
    return;
  }

  for (const serverCfg of servers) {
    connectServer(serverCfg);
  }

  // Watchdog: detect zombie connections every 60s
  let watchdogTicks = 0;
  watchdogInterval = setInterval(() => {
    const now = Date.now();
    watchdogTicks++;

    for (const [name, conn] of connections) {
      if (!conn.state.connected) continue;
      const staleSec = (now - conn.state.lastEventTime) / 1000;
      if (staleSec > 300) {
        log.warn({ name, staleSec: Math.round(staleSec) }, 'No events received, forcing reconnect');
        conn.socket.disconnect();
        conn.socket.connect();
        continue;
      }
      // Count is live (events flowing) but the players ack hasn't returned fresh
      // data — the roster is frozen. Recycle the socket so SquadJS rebinds the ack.
      if (isRosterStale(conn.state, now, ROSTER_STALE_MS)) {
        log.warn({ name, rosterStaleSec: Math.round((now - conn.state.lastPlayersOk) / 1000) }, 'Roster ack stale while connected, forcing reconnect');
        conn.socket.disconnect();
        conn.socket.connect();
      }
    }

    // Log connection state summary every 5 minutes (every 5th tick)
    if (watchdogTicks % 5 === 0) {
      const summary = [];
      for (const [name, conn] of connections) {
        const staleSec = Math.round((now - conn.state.lastEventTime) / 1000);
        summary.push({
          name,
          connected: conn.state.connected,
          players: conn.state.playerCount,
          lastEventSec: staleSec,
        });
      }
      log.debug({ servers: summary }, 'SquadJS connection state summary');
    }
  }, 60_000);
}

export function disconnect() {
  if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }
  for (const [name, conn] of connections) {
    if (conn.socket) {
      conn.socket.removeAllListeners();
      conn.socket.disconnect();
      conn.state.connected = false;
      log.info({ name }, 'Disconnected from SquadJS');
    }
  }
  connections.clear();
}

export function getServerStateById(serverId) {
  const entries = [];
  for (const conn of connections.values()) {
    entries.push({ serverId: conn.serverId, state: conn.state });
  }
  const state = pickServerStateById(entries, serverId);
  if (!state) return null; // unresolved id or no matching connection — caller shows "unavailable"
  return { ...state, players: [...state.players] };
}

// Name-based lookup (no fallback) — used by the layer-rotation validator, which
// identifies its server by the SQUADJS_SERVERS connection name.
export function getServerStateByName(name) {
  if (!name) return null;
  const conn = connections.get(name);
  return conn ? { ...conn.state, players: [...conn.state.players] } : null;
}

export function getAllServerStates() {
  const result = [];
  for (const [name, conn] of connections) {
    result.push({
      name,
      serverId: conn.serverId ?? null,
      state: { ...conn.state, players: [...conn.state.players] },
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export function extractGameMode(layerName) {
  if (!layerName) return null;
  if (typeof layerName !== 'string') layerName = layerName.name ?? String(layerName);
  const normalized = layerName.replace(/\s+/g, '_');
  const match = normalized.match(/_(AAS|RAAS|Invasion|Insurgency|Seed|Skirmish|TC|TA|Destruction)_/i);
  return match ? match[1] : null;
}

export function isConnectedById(serverId) {
  const entries = [];
  for (const conn of connections.values()) {
    entries.push({ serverId: conn.serverId, state: conn.state });
  }
  const state = pickServerStateById(entries, serverId);
  return state ? !!state.connected : false;
}
