import { describe, test, expect } from 'bun:test';
import { computeDiff, ChangeType } from '../diff.js';

const UL = '\x1b[4m'; // inline character-highlight underline code

describe('computeDiff inline highlighting', () => {
  test('does not inline-highlight wholesale-reordered layer rotation lines', () => {
    // A regenerated rotation: every line becomes a different, unrelated layer.
    // Pairing + char-diffing unrelated lines used to underline coincidental
    // shared fragments (_Seed_v1, faction codes), producing garbled output.
    // Real config files end with a trailing newline; without it the
    // "\ No newline at end of file" marker masks the bug.
    const oldRot = [
      'Fallujah_Seed_v1 WPMC CAF',
      'Chora_RAAS_v1 USA RGF',
      'GooseBay_RAAS_v2 PLA+Motorized CAF',
      '',
    ].join('\n');
    const newRot = [
      'Tallil_Seed_v1 AFU PLA',
      'Fallujah_RAAS_v1 IMF MEI',
      'BlackCoast_RAAS_v2 RGF+Support BAF+Support',
      '',
    ].join('\n');

    const diff = computeDiff(oldRot, newRot, 'LayerRotation.cfg');

    expect(diff.formatted).not.toContain(UL);
    // Unrelated lines are removals + additions, not in-place modifications.
    expect(diff.stats.modified).toBe(0);
    expect(diff.stats.removed).toBe(3);
    expect(diff.stats.added).toBe(3);
    expect(diff.changeType).toBe(ChangeType.MIXED);
    // The plain layer names still appear in the rendered diff.
    expect(diff.formatted).toContain('Fallujah_Seed_v1 WPMC CAF');
    expect(diff.formatted).toContain('Tallil_Seed_v1 AFU PLA');
  });

  test('still inline-highlights a genuine localized edit', () => {
    const oldContent = 'MapRotationMode = random\n';
    const newContent = 'MapRotationMode = sequential\n';

    const diff = computeDiff(oldContent, newContent, 'Server.cfg');

    expect(diff.formatted).toContain(UL);
    expect(diff.stats.modified).toBe(1);
  });
});
