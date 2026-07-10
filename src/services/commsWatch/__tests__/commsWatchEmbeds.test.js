import { describe, test, expect } from 'bun:test';
import { buildBoardEmbed, buildProspectAlertEmbed } from '../commsWatchEmbeds.js';

describe('buildBoardEmbed', () => {
  test('empty state is green and says everyone on comms', () => {
    const e = buildBoardEmbed([], 'Main', 0).toJSON();
    expect(e.color).toBe(0x57f287);
    expect(e.description).toContain('on comms');
    expect(e.title).toContain('Main');
  });

  test('violators listed longest-first with mention, name, duration, tag', () => {
    const e = buildBoardEmbed(
      [
        { discordId: '1', name: 'Alpha', kind: 'member', offCommsMs: 120000 },
        { discordId: '2', name: 'Bravo', kind: 'prospect', offCommsMs: 900000 },
      ],
      'Main',
      0,
    ).toJSON();
    expect(e.color).toBe(0xfee75c);
    const firstIdx = e.description.indexOf('<@2>');
    const secondIdx = e.description.indexOf('<@1>');
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(firstIdx).toBeLessThan(secondIdx); // 15m before 2m
    expect(e.description).toContain('`Bravo`');
    expect(e.description).toContain('[Prospect]');
    expect(e.description).toContain('[Member]');
  });
});

describe('buildProspectAlertEmbed', () => {
  test('new title, mentions prospect + server, and carries no duration fields', () => {
    const e = buildProspectAlertEmbed({ userId: '99', alias: 'Zed' }, 'Main').toJSON();
    expect(e.title).toBe('Prospect not on Discord while in-game');
    expect(e.description).toContain('<@99>');
    expect(e.description).toContain('Zed');
    expect(e.description).toContain('Main');
    expect(e.description).not.toMatch(/\d+m\b/); // no "15m" duration noise
    expect(e.fields ?? []).toHaveLength(0); // Since/Duration removed
  });
});
