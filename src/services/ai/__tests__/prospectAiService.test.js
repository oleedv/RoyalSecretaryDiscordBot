import { describe, test, expect, mock } from 'bun:test';

mock.module('../../../logger.js', () => ({
  default: { child: () => ({ warn() {}, info() {}, error() {} }) },
}));

const { buildUserMessage } = await import('../prospectAiService.js');

const prospect = {
  alias: 'TestAlias',
  nationality: 'Norway',
  date_of_birth: '15-03-1994',
  squad_hours: 400,
  about_yourself: 'I play SL',
  prev_clan: 'No',
  why_rb: 'Because',
  active_hours: '18-23 UTC',
  competitive: 'No',
  steam_id: '76561198000000001',
};

describe('buildUserMessage', () => {
  test('does not send date of birth to Anthropic', () => {
    const prompt = buildUserMessage(prospect, null);
    expect(prompt).not.toContain('15-03-1994');
    expect(prompt).not.toContain('Date of Birth');
    expect(prompt).not.toContain('1994');
    expect(prompt).toContain('Age: 18 or over');
  });

  test('still includes the rest of the application', () => {
    const prompt = buildUserMessage(prospect, 'FETCHED');
    expect(prompt).toContain('Alias: TestAlias');
    expect(prompt).toContain('Country: Norway');
    expect(prompt).toContain('Steam ID: 76561198000000001');
    expect(prompt).toContain('FETCHED');
  });
});
