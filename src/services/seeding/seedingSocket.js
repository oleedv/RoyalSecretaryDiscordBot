import { io } from 'socket.io-client';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'seedingSocket' });

let socket = null;
const stateListeners = [];

const serverState = {
  playerCount: 0,
  currentMap: null,
  currentLayer: null,
  serverName: null,
  connected: false,
};

// Extract map name from layer string, e.g. "Mutaha_Seed_v1" -> "Mutaha"
function extractMapName(layerName) {
  if (!layerName) return null;
  // Layer format: "MapName_GameMode_vX" or "Map Name GameMode vX"
  const normalized = layerName.replace(/\s+/g, '_');
  const match = normalized.match(/^(.+?)_(?:AAS|RAAS|Invasion|Insurgency|Seed|Skirmish|TC|TA|Destruction)_/i);
  return match ? match[1].replace(/_/g, ' ') : layerName.split('_')[0];
}

function notifyListeners() {
  for (const cb of stateListeners) {
    try { cb(serverState); } catch (err) {
      log.error({ err }, 'State change listener error');
    }
  }
}

export function connect() {
  const server = config.squadjs?.[0];
  if (!server) {
    log.warn('No SquadJS server configured (SQUADJS_SERVERS env var missing)');
    return;
  }

  log.info({ name: server.name, url: server.url }, 'Connecting to SquadJS');

  socket = io(server.url, {
    auth: { token: server.token },
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity,
  });

  socket.on('connect', () => {
    serverState.connected = true;
    log.info({ name: server.name }, 'Connected to SquadJS');
  });

  socket.on('disconnect', (reason) => {
    serverState.connected = false;
    log.warn({ reason }, 'Disconnected from SquadJS');
  });

  socket.on('connect_error', (err) => {
    log.error({ err: err.message }, 'SquadJS connection error');
  });

  // Primary server info event
  socket.on('UPDATED_A2S_INFORMATION', (data) => {
    serverState.playerCount = data.a2sPlayerCount ?? data.playerCount ?? serverState.playerCount;
    serverState.currentLayer = data.currentLayer ?? serverState.currentLayer;
    serverState.currentMap = extractMapName(serverState.currentLayer);
    serverState.serverName = data.serverName ?? serverState.serverName;
    log.debug({ playerCount: serverState.playerCount, map: serverState.currentMap, layer: serverState.currentLayer }, 'A2S update');
    notifyListeners();
  });

  // Map change event
  socket.on('NEW_GAME', (data) => {
    serverState.currentLayer = data.currentLayer ?? data.layer ?? serverState.currentLayer;
    serverState.currentMap = extractMapName(serverState.currentLayer);
    serverState.playerCount = 0;
    log.info({ map: serverState.currentMap, layer: serverState.currentLayer }, 'New game started');
    notifyListeners();
  });

  // Player join/leave for count tracking
  socket.on('PLAYER_CONNECTED', () => {
    serverState.playerCount++;
    notifyListeners();
  });

  socket.on('PLAYER_DISCONNECTED', () => {
    serverState.playerCount = Math.max(0, serverState.playerCount - 1);
    notifyListeners();
  });

  // Log unknown events at debug level for discovery
  socket.onAny((event, data) => {
    if (!['UPDATED_A2S_INFORMATION', 'NEW_GAME', 'PLAYER_CONNECTED', 'PLAYER_DISCONNECTED'].includes(event)) {
      log.debug({ event, dataKeys: data ? Object.keys(data) : null }, 'SquadJS event');
    }
  });
}

export function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
    serverState.connected = false;
    log.info('Disconnected from SquadJS');
  }
}

export function getServerState() {
  return { ...serverState };
}

export function onStateChange(callback) {
  stateListeners.push(callback);
  return () => {
    const idx = stateListeners.indexOf(callback);
    if (idx !== -1) stateListeners.splice(idx, 1);
  };
}

export function isConnected() {
  return serverState.connected;
}
