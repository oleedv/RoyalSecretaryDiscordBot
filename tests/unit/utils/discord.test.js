import { describe, it, expect, mock } from 'bun:test';
import { isFileSendFailure, trySendWithFiles } from '../../../src/utils/discord.js';

describe('isFileSendFailure', () => {
  it('matches Discord request-entity-too-large', () => {
    expect(isFileSendFailure({ code: 40005 })).toBe(true);
  });

  it('matches AbortError from REST timeout', () => {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    expect(isFileSendFailure(err)).toBe(true);
  });

  it('matches Node ABORT_ERR / undici abort messages', () => {
    expect(isFileSendFailure({ code: 'ABORT_ERR', message: 'aborted' })).toBe(true);
    expect(isFileSendFailure({ message: 'This operation was aborted due to timeout' })).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isFileSendFailure({ code: 50001, message: 'Missing Access' })).toBe(false);
    expect(isFileSendFailure(null)).toBe(false);
  });
});

describe('trySendWithFiles', () => {
  it('returns the message when send succeeds with files', async () => {
    const sent = { id: '1' };
    const target = { send: mock(async () => sent) };
    const options = { content: 'hi', files: [{ attachment: 'https://cdn/x.mp4', name: 'x.mp4' }] };

    const result = await trySendWithFiles(target, options);

    expect(result).toEqual({ msg: sent, tooLarge: false });
    expect(target.send).toHaveBeenCalledTimes(1);
    expect(target.send.mock.calls[0][0]).toBe(options);
  });

  it('retries without files on AbortError so relay still delivers the embed', async () => {
    const abortErr = new Error('The operation was aborted.');
    abortErr.name = 'AbortError';
    const fallback = { id: '2' };
    const target = {
      send: mock(async (opts) => {
        if (opts.files) throw abortErr;
        return fallback;
      }),
    };
    const options = {
      embeds: [{ title: 'Ticket' }],
      files: [{ attachment: 'https://cdn/clip.mp4', name: 'clip.mp4' }],
    };

    const result = await trySendWithFiles(target, options);

    expect(result).toEqual({ msg: fallback, tooLarge: true });
    expect(target.send).toHaveBeenCalledTimes(2);
    expect(target.send.mock.calls[1][0]).toEqual({ embeds: options.embeds });
    // Must not mutate the caller's options (staff/DM paths reuse them)
    expect(options.files).toHaveLength(1);
  });

  it('retries without files on Discord 40005', async () => {
    const tooLarge = Object.assign(new Error('Request entity too large'), { code: 40005 });
    const fallback = { id: '3' };
    const target = {
      send: mock(async (opts) => {
        if (opts.files) throw tooLarge;
        return fallback;
      }),
    };

    const result = await trySendWithFiles(target, {
      content: 'text',
      files: [{ attachment: 'https://cdn/big.bin', name: 'big.bin' }],
    });

    expect(result.tooLarge).toBe(true);
    expect(result.msg).toBe(fallback);
  });

  it('rethrows non-file failures', async () => {
    const err = Object.assign(new Error('Missing Access'), { code: 50001 });
    const target = { send: mock(async () => { throw err; }) };

    await expect(trySendWithFiles(target, {
      content: 'x',
      files: [{ attachment: 'https://cdn/a.mp4', name: 'a.mp4' }],
    })).rejects.toBe(err);
  });

  it('rethrows AbortError when there were no files to drop', async () => {
    const abortErr = new Error('The operation was aborted.');
    abortErr.name = 'AbortError';
    const target = { send: mock(async () => { throw abortErr; }) };

    await expect(trySendWithFiles(target, { content: 'no files' })).rejects.toBe(abortErr);
    expect(target.send).toHaveBeenCalledTimes(1);
  });
});
