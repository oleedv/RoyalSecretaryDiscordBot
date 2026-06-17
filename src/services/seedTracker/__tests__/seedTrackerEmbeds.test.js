import { describe, test, expect } from 'bun:test';
import { buildMilestoneTrack } from '../seedTrackerEmbeds.js';

describe('buildMilestoneTrack', () => {
  test('empty progress: halfway/goal shown unfilled', () => {
    expect(buildMilestoneTrack(0, 10)).toBe('○━○━○━○━◇━○━○━○━○━◎');
  });

  test('halfway reached fills the halfway diamond', () => {
    expect(buildMilestoneTrack(5, 10)).toBe('●━●━●━●━◆━○━○━○━○━◎');
  });

  test('goal reached fills the goal marker', () => {
    expect(buildMilestoneTrack(10, 10)).toBe('●━●━●━●━◆━●━●━●━●━◉');
  });

  test('done is clamped to total', () => {
    expect(buildMilestoneTrack(12, 10)).toBe(buildMilestoneTrack(10, 10));
  });

  test('non-default total places halfway at floor(total/2)', () => {
    expect(buildMilestoneTrack(3, 7)).toBe('●━●━◆━○━○━○━◎');
  });
});
