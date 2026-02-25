import { io } from 'socket.io-client';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'seedingSocket' });

const connections = new Map(); // name -> { socket, state }
const stateListeners = [];

const KNOWN_EVENTS = [
  'UPDATED_A2S_INFORMATION', 'UPDATED_PLAYER_INFORMATION',
  'UPDATED_LAYER_INFORMATION', 'NEW_GAME',
  'PLAYER_CONNECTED', 'PLAYER_DISCONNECTED',
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
  };
}

// Extract map name from layer string, e.g. "Mutaha_Seed_v1" -> "Mutaha"
function extractMapName(layerName) {
  if (!layerName) return null;
  const normalized = layerName.replace(/\s+/g, '_');
  const match = normalized.match(/^(.+?)_(?:AAS|RAAS|Invasion|Insurgency|Seed|Skirmish|TC|TA|Destruction)_/i);
  return match ? match[1].replace(/_/g, ' ') : layerName.split('_')[0];
}

function notifyListeners() {
  for (const cb of stateListeners) {
    try { cb(); } catch (err) {
      log.error({ err }, 'State change listener error');
    }
  }
}

function fetchPlayers(conn) {
  if (!conn.socket?.connected) return;
  conn.socket.emit('players', (data) => {
    if (Array.isArray(data)) {
      conn.state.players = data;
      log.debug({ count: data.length }, 'Fetched player list');
    }
  });
}

function fetchLayerObj(conn) {
  if (!conn.socket?.connected) return;
  conn.socket.emit('currentLayer', (data) => {
    if (data) {
      conn.state.currentLayerObj = data;
      log.debug({ layer: data.name }, 'Fetched layer object');
    }
  });
}

function connectServer(serverCfg) {
  const conn = { socket: null, state: createState() };
  connections.set(serverCfg.name, conn);

  log.info({ name: serverCfg.name, url: serverCfg.url }, 'Connecting to SquadJS');

  conn.socket = io(serverCfg.url, {
    auth: { token: serverCfg.token },
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity,
  });

  conn.socket.on('connect', () => {
    conn.state.connected = true;
    log.info({ name: serverCfg.name }, 'Connected to SquadJS');
  });

  conn.socket.on('disconnect', (reason) => {
    conn.state.connected = false;
    log.warn({ name: serverCfg.name, reason }, 'Disconnected from SquadJS');
  });

  conn.socket.on('connect_error', (err) => {
    log.error({ name: serverCfg.name, err: err.message }, 'SquadJS connection error');
  });

  conn.socket.on('UPDATED_A2S_INFORMATION', (data) => {
    const s = conn.state;
    s.playerCount = data.a2sPlayerCount ?? data.playerCount ?? s.playerCount;
    s.currentLayer = data.currentLayer ?? s.currentLayer;
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
    notifyListeners();
  });

  conn.socket.on('UPDATED_PLAYER_INFORMATION', () => fetchPlayers(conn));
  conn.socket.on('UPDATED_LAYER_INFORMATION', () => fetchLayerObj(conn));

  conn.socket.on('NEW_GAME', (data) => {
    conn.state.currentLayer = data.currentLayer ?? data.layer ?? conn.state.currentLayer;
    conn.state.currentMap = extractMapName(conn.state.currentLayer);
    conn.state.playerCount = 0;
    log.info({ name: serverCfg.name, map: conn.state.currentMap, layer: conn.state.currentLayer }, 'New game started');
    notifyListeners();
  });

  conn.socket.on('PLAYER_CONNECTED', () => {
    conn.state.playerCount++;
    notifyListeners();
  });

  conn.socket.on('PLAYER_DISCONNECTED', () => {
    conn.state.playerCount = Math.max(0, conn.state.playerCount - 1);
    notifyListeners();
  });

  conn.socket.onAny((event, data) => {
    if (!KNOWN_EVENTS.includes(event)) {
      log.debug({ name: serverCfg.name, event, dataKeys: data ? Object.keys(data) : null }, 'SquadJS event');
    }
  });
}

export function connect() {
  const servers = config.squadjs;
  if (!servers?.length) {
    log.warn('No SquadJS server configured (SQUADJS_SERVERS env var missing)');
    return;
  }

  for (const serverCfg of servers) {
    connectServer(serverCfg);
  }
}

export function disconnect() {
  for (const [name, conn] of connections) {
    if (conn.socket) {
      conn.socket.disconnect();
      conn.state.connected = false;
      log.info({ name }, 'Disconnected from SquadJS');
    }
  }
  connections.clear();
}

export function getServerState(name) {
  if (name) {
    const conn = connections.get(name);
    return conn ? { ...conn.state, players: [...conn.state.players] } : createState();
  }
  // Default: first server
  const first = connections.values().next().value;
  return first ? { ...first.state, players: [...first.state.players] } : createState();
}

export function getAllServerStates() {
  const result = [];
  for (const [name, conn] of connections) {
    result.push({ name, state: { ...conn.state, players: [...conn.state.players] } });
  }
  return result;
}

export function onStateChange(callback) {
  stateListeners.push(callback);
  return () => {
    const idx = stateListeners.indexOf(callback);
    if (idx !== -1) stateListeners.splice(idx, 1);
  };
}

export function extractGameMode(layerName) {
  if (!layerName) return null;
  const normalized = layerName.replace(/\s+/g, '_');
  const match = normalized.match(/_(AAS|RAAS|Invasion|Insurgency|Seed|Skirmish|TC|TA|Destruction)_/i);
  return match ? match[1] : null;
}

export function isConnected(name) {
  if (name) return connections.get(name)?.state.connected ?? false;
  const first = connections.values().next().value;
  return first?.state.connected ?? false;
}
