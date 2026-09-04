import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../../');

describe('deploy workflows do not notify Discord on push', () => {
  for (const file of ['.github/workflows/deploy-production.yml', '.github/workflows/deploy-staging.yml']) {
    it(`${file} has no Discord webhook notify job`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src).not.toContain('discord.com/api/webhooks');
      expect(src).not.toContain('Notify Discord');
      expect(src).not.toContain('DISCORD_DEPLOY_WEBHOOK');
    });
  }
});
