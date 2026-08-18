// Single source of truth for /refresh-panels choices.
// Add a row here whenever a new persistent live embed/panel is introduced.
export const REFRESHABLE_PANELS = [
  { key: 'ticket', label: 'Ticket', choiceName: 'Ticket' },
  { key: 'prospect', label: 'Prospect', choiceName: 'Prospect' },
  { key: 'verify', label: 'Verify', choiceName: 'Verify' },
  { key: 'purged', label: 'Purged', choiceName: 'Purged' },
  { key: 'seeding', label: 'Seeding', choiceName: 'Seeding' },
  { key: 'server-status', label: 'Server Status', choiceName: 'Server Status' },
  { key: 'quick-status', label: 'Quick Status', choiceName: 'Quick Status' },
  { key: 'layer-rotation', label: 'Layer Rotation', choiceName: 'Layer Rotation' },
  { key: 'sl-leaderboard', label: 'SL Leaderboard', choiceName: 'SL Leaderboard' },
  { key: 'comms-board', label: 'Comms Board', choiceName: 'Comms Board' },
];

export const REFRESHABLE_PANEL_KEYS = REFRESHABLE_PANELS.map((p) => p.key);
