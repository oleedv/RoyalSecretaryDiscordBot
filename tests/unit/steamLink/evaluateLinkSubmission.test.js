import { describe, it, expect } from 'bun:test';
import { evaluateLinkSubmission } from '../../../src/services/steamLink.js';

const STEAM = '76561198012345678';
const OTHER_STEAM = '76561190000000000';
const validValidation = { valid: true, steamId: STEAM };

describe('evaluateLinkSubmission', () => {
  it('rejects when the user did not confirm the account is theirs', () => {
    const r = evaluateLinkSubmission({
      isMine: 'No',
      validation: validValidation,
      currentLink: null,
      steamIdOwner: null,
      userId: 'u1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/confirm/i);
  });

  it('rejects an invalid Steam ID, passing through the validator reason', () => {
    const r = evaluateLinkSubmission({
      isMine: 'Yes',
      validation: { valid: false, reason: 'Invalid Steam ID.' },
      currentLink: null,
      steamIdOwner: null,
      userId: 'u1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Invalid Steam ID.');
  });

  it('rejects when the user is already linked to the same Steam ID', () => {
    const r = evaluateLinkSubmission({
      isMine: 'Yes',
      validation: validValidation,
      currentLink: STEAM,
      steamIdOwner: 'u1',
      userId: 'u1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already linked/i);
  });

  it('rejects when the user is already linked to a different Steam ID', () => {
    const r = evaluateLinkSubmission({
      isMine: 'Yes',
      validation: validValidation,
      currentLink: OTHER_STEAM,
      steamIdOwner: null,
      userId: 'u1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already linked/i);
  });

  it('rejects when the Steam ID belongs to another Discord account', () => {
    const r = evaluateLinkSubmission({
      isMine: 'Yes',
      validation: validValidation,
      currentLink: null,
      steamIdOwner: 'someone-else',
      userId: 'u1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/another Discord account/i);
  });

  it('accepts a confirmed, valid, unlinked, unowned Steam ID', () => {
    const r = evaluateLinkSubmission({
      isMine: 'Yes',
      validation: validValidation,
      currentLink: null,
      steamIdOwner: null,
      userId: 'u1',
    });
    expect(r).toEqual({ ok: true, steamId: STEAM });
  });

  it('does not treat the user as their own conflict', () => {
    const r = evaluateLinkSubmission({
      isMine: 'Yes',
      validation: validValidation,
      currentLink: null,
      steamIdOwner: 'u1',
      userId: 'u1',
    });
    expect(r.ok).toBe(true);
    expect(r.steamId).toBe(STEAM);
  });
});
