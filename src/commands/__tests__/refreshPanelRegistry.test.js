import { describe, expect, test } from 'bun:test';
import { REFRESHABLE_PANELS, REFRESHABLE_PANEL_KEYS } from '../refreshPanelRegistry.js';
import { PANEL_REFRESHERS } from '../refresh-panels.js';

describe('refresh-panels registry', () => {
  test('includes every persistent live panel/embed', () => {
    expect(REFRESHABLE_PANEL_KEYS).toEqual([
      'ticket',
      'prospect',
      'verify',
      'purged',
      'seeding',
      'server-status',
      'quick-status',
      'layer-rotation',
      'sl-leaderboard',
      'comms-board',
    ]);
  });

  test('every panel has a unique key, label, and slash-command choice name', () => {
    const keys = REFRESHABLE_PANELS.map((p) => p.key);
    const names = REFRESHABLE_PANELS.map((p) => p.choiceName);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(names).size).toBe(names.length);
    for (const panel of REFRESHABLE_PANELS) {
      expect(panel.key).toBeTruthy();
      expect(panel.label).toBeTruthy();
      expect(panel.choiceName).toBeTruthy();
    }
  });

  test('every registry key has a refresher wired in /refresh-panels', () => {
    expect(Object.keys(PANEL_REFRESHERS).sort()).toEqual([...REFRESHABLE_PANEL_KEYS].sort());
    for (const key of REFRESHABLE_PANEL_KEYS) {
      expect(typeof PANEL_REFRESHERS[key]).toBe('function');
    }
  });
});
