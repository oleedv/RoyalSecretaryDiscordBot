// Single source of truth for clan-report panels.
// Emoji codepoints are written as Unicode escapes (\u{...}) so the source
// stays glyph-free; discord.js renders them as native emoji on the button.

export const PANELS = [
  { id: 'overview', emoji: '\u{1F4CA}',            label: 'Overview', row: 'top' },
  { id: 'activity', emoji: '\u{23F1}\u{FE0F}',     label: 'Activity', row: 'top' },
  { id: 'seeding',  emoji: '\u{1F331}',            label: 'Seeding',  row: 'top' },
  { id: 'roster',   emoji: '\u{1F465}',            label: 'Roster',   row: 'top' },
  { id: 'combat',   emoji: '\u{2694}\u{FE0F}',     label: 'Combat',   row: 'top' },
  { id: 'matches',  emoji: '\u{1F3C6}',            label: 'Matches',  row: 'bottom' },
  { id: 'heatmap',  emoji: '\u{1F550}',            label: 'Heatmap',  row: 'bottom' },
  { id: 'growth',   emoji: '\u{1F4C8}',            label: 'Growth',   row: 'bottom' },
];

export const PANEL_BY_ID = Object.fromEntries(PANELS.map((p) => [p.id, p]));

export function getPanel(id) {
  return PANEL_BY_ID[id] || null;
}

export const WINDOWS = [
  { id: '7',   label: '7d',  days: 7 },
  { id: '30',  label: '30d', days: 30 },
  { id: '90',  label: '90d', days: 90 },
  { id: 'all', label: '\u{221E}', days: null },
];

export const WINDOW_BY_ID = Object.fromEntries(WINDOWS.map((w) => [w.id, w]));

export function getWindow(id) {
  return WINDOW_BY_ID[id] || WINDOW_BY_ID['30'];
}
