import { describe, it, expect } from 'bun:test';
import {
  isThreadChannel,
  getStaffChannelId,
  getThreadMeta,
  getReplyToId,
  serializeEmbeds,
  isRelayMirrorId,
} from '../../../src/services/channelTranscript/transcriptMeta.js';

describe('isThreadChannel', () => {
  it('uses isThread() when present', () => {
    expect(isThreadChannel({ isThread: () => true })).toBe(true);
    expect(isThreadChannel({ isThread: () => false })).toBe(false);
  });

  it('is false for missing channel', () => {
    expect(isThreadChannel(null)).toBe(false);
    expect(isThreadChannel({})).toBe(false);
  });
});

describe('getStaffChannelId', () => {
  it('returns the channel id for a normal staff channel', () => {
    expect(getStaffChannelId({ id: 'ticket-ch', parentId: 'category', isThread: () => false })).toBe('ticket-ch');
  });

  it('returns the parent channel id for a Discord thread', () => {
    expect(getStaffChannelId({
      id: 'thread-1',
      parentId: 'ticket-ch',
      isThread: () => true,
    })).toBe('ticket-ch');
  });

  it('returns null without a resolvable id', () => {
    expect(getStaffChannelId(null)).toBe(null);
    expect(getStaffChannelId({ isThread: () => true })).toBe(null);
  });
});

describe('getThreadMeta', () => {
  it('is empty for the parent channel', () => {
    expect(getThreadMeta({ id: 'ch', name: 't-user', isThread: () => false }))
      .toEqual({ threadId: null, threadName: null });
  });

  it('captures thread id and name', () => {
    expect(getThreadMeta({ id: 'th-9', name: 'steam check', isThread: () => true }))
      .toEqual({ threadId: 'th-9', threadName: 'steam check' });
  });
});

describe('getReplyToId', () => {
  it('reads Discord reply reference', () => {
    expect(getReplyToId({ reference: { messageId: 'parent-1' } })).toBe('parent-1');
  });

  it('is null when not a reply', () => {
    expect(getReplyToId({ content: 'hi' })).toBe(null);
    expect(getReplyToId(null)).toBe(null);
  });
});

describe('serializeEmbeds', () => {
  it('returns null when there are no embeds', () => {
    expect(serializeEmbeds({ embeds: [] })).toBe(null);
    expect(serializeEmbeds({})).toBe(null);
  });

  it('uses toJSON when available', () => {
    const message = {
      embeds: [{ toJSON: () => ({ title: 'Ticket', description: 'hello' }) }],
    };
    expect(serializeEmbeds(message)).toEqual([{ title: 'Ticket', description: 'hello' }]);
  });
});

describe('isRelayMirrorId', () => {
  it('is true when another row already stores this id as channel_message_id', () => {
    const ids = new Set(['embed-1']);
    expect(isRelayMirrorId('embed-1', ids)).toBe(true);
    expect(isRelayMirrorId('other', ids)).toBe(false);
  });
});
