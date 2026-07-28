import { describe, it, expect } from 'bun:test';
import { findProfanity, getSafeChannelName, isInappropriateName } from './contentFilter.js';

describe('findProfanity', () => {
  it('blocks an exact list word', () => {
    expect(findProfanity('cuck')).toBe('cuck');
  });

  it('derives inflections from a base not itself in the list (s / ed)', () => {
    // 'cucks' / 'cucked' are NOT list entries -> proves suffix stripping works.
    expect(findProfanity('cucks')).toBe('cuck');
    expect(findProfanity('cucked')).toBe('cuck');
  });

  it('blocks common inflections however the list stores them', () => {
    for (const w of ['fucks', 'fucked', 'fucking', 'fuckers', 'bitches', 'shits']) {
      expect(findProfanity(w)).toBeTruthy();
    }
  });

  it('matches a list word as a standalone token in a longer name', () => {
    expect(findProfanity('cuck lounge')).toBe('cuck');
    expect(findProfanity('the cuck zone')).toBe('cuck');
    expect(findProfanity('cuck_lord')).toBe('cuck');
  });

  it('does NOT match a list word embedded in a larger word', () => {
    expect(findProfanity('asdcuckasd')).toBeNull();
    expect(findProfanity('classic')).toBeNull();
    expect(findProfanity('analysis')).toBeNull();
    expect(findProfanity('canal')).toBeNull();
    expect(findProfanity('sparse')).toBeNull();
    expect(findProfanity('bass')).toBeNull();
    expect(findProfanity('grass')).toBeNull();
    expect(findProfanity('scumbag')).toBeNull(); // 'scum' is one token, != 'cum'
    expect(findProfanity('cumberland')).toBeNull(); // 'cum' base, but not a stripped suffix
  });

  it('matches whole-word slurs but not innocent lookalikes', () => {
    expect(findProfanity('anal')).toBe('anal');
    expect(findProfanity('ass')).toBe('ass');
    expect(findProfanity('asses')).toBeTruthy();
    expect(findProfanity('passed')).toBeNull();
    expect(findProfanity('glasses')).toBeNull();
    expect(findProfanity('squad')).toBeNull(); // community name must never be flagged
  });

  it('catches simple diacritic substitution', () => {
    expect(findProfanity('fück')).toBe('fuck');
  });

  it('returns null for clean names and bad input', () => {
    expect(findProfanity('My Cool Channel')).toBeNull();
    expect(findProfanity('Squad Stack')).toBeNull();
    expect(findProfanity('')).toBeNull();
    expect(findProfanity(null)).toBeNull();
  });
});

describe('getSafeChannelName', () => {
  it('rejects profane names with reason + matched word', () => {
    const r = getSafeChannelName('cuck lounge');
    expect(r.safe).toBe(false);
    expect(r.reason).toBe('profanity');
    expect(r.matched).toBe('cuck');
  });

  it('accepts clean names unchanged', () => {
    const r = getSafeChannelName('My Cool Channel');
    expect(r.safe).toBe(true);
    expect(r.name).toBe('My Cool Channel');
    expect(r.matched).toBeNull();
  });

  it('allows all-caps names', () => {
    const r = getSafeChannelName('SQUAD STACK');
    expect(r.safe).toBe(true);
    expect(r.name).toBe('SQUAD STACK');
    expect(r.reason).toBeNull();
  });

  it('rejects URLs and mentions', () => {
    expect(getSafeChannelName('join https://evil.gg/x').reason).toBe('url');
    expect(getSafeChannelName('hey <@123456789>').reason).toBe('mention');
  });

  it('rejects too-short names', () => {
    expect(getSafeChannelName('a').safe).toBe(false);
  });

  it('truncates over-long clean names to 100 chars', () => {
    const r = getSafeChannelName('a'.repeat(150));
    // 150 'a's is clean; should be truncated, still safe
    expect(r.safe).toBe(true);
    expect(r.name.length).toBe(100);
  });
});

describe('isInappropriateName', () => {
  it('flags profanity and bad formats, passes clean names', () => {
    expect(isInappropriateName('cuck')).toBe(true);
    expect(isInappropriateName('fucking lobby')).toBe(true);
    expect(isInappropriateName('My Channel')).toBe(false);
    expect(isInappropriateName('Squad Night')).toBe(false);
    expect(isInappropriateName('SQUAD STACK')).toBe(false);
  });
});
