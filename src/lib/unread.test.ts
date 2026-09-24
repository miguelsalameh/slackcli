import { describe, expect, it } from 'bun:test';
import { fetchUnreadChannels, resolveUnreadOldest } from './unread.ts';
import type { SlackClient } from './slack-client.ts';

function infoClient(channel: Record<string, unknown> | undefined) {
  const calls: string[] = [];
  const client = {
    async getConversationInfo(channelId: string) {
      calls.push(channelId);
      return channel === undefined ? {} : { channel };
    },
  };
  return { client, calls };
}

describe('resolveUnreadOldest', () => {
  it('returns the last_read marker for the channel', async () => {
    const { client, calls } = infoClient({ last_read: '1735689600.000100' });
    expect(await resolveUnreadOldest(client, 'C123')).toBe('1735689600.000100');
    expect(calls).toEqual(['C123']);
  });

  it('stringifies a numeric last_read', async () => {
    const { client } = infoClient({ last_read: 1735689600 });
    expect(await resolveUnreadOldest(client, 'C123')).toBe('1735689600');
  });

  it('rejects --oldest without calling Slack', async () => {
    const { client, calls } = infoClient({ last_read: '1.0' });
    await expect(resolveUnreadOldest(client, 'C123', { oldest: '1.0' })).rejects.toThrow('mutually exclusive');
    expect(calls).toEqual([]);
  });

  it('rejects threads without calling Slack', async () => {
    const { client, calls } = infoClient({ last_read: '1.0' });
    await expect(resolveUnreadOldest(client, 'C123', { threadTs: '2.0' })).rejects.toThrow('cannot be combined with a thread');
    expect(calls).toEqual([]);
  });

  it('fails when Slack returns no last_read', async () => {
    await expect(resolveUnreadOldest(infoClient({ id: 'C123' }).client, 'C123')).rejects.toThrow('no last_read');
    await expect(resolveUnreadOldest(infoClient(undefined).client, 'C123')).rejects.toThrow('no last_read');
    await expect(resolveUnreadOldest(infoClient({ last_read: '' }).client, 'C123')).rejects.toThrow('no last_read');
  });
});

describe('fetchUnreadChannels last_read', () => {
  function browserClient(counts: any) {
    return {
      authType: 'browser',
      async getUnreadCounts() { return counts; },
      async getConversationInfo(id: string) { return { channel: { id, name: `name-${id}` } }; },
      async getUserInfo() { return {}; },
    } as unknown as SlackClient;
  }

  it('passes last_read through as a string for browser auth', async () => {
    const channels = await fetchUnreadChannels(browserClient({
      channels: [{ id: 'C1', has_unreads: true, last_read: 1735689600.0001 }],
      ims: [{ id: 'D1', has_unreads: true, last_read: '1735689700.000200' }],
    }));
    const byId = Object.fromEntries(channels.map((ch) => [ch.id, ch]));
    expect(byId.C1?.last_read).toBe('1735689600.0001');
    expect(byId.D1?.last_read).toBe('1735689700.000200');
  });

  it('omits last_read when Slack does not send one', async () => {
    const [channel] = await fetchUnreadChannels(browserClient({
      channels: [{ id: 'C1', has_unreads: true }],
    }));
    expect(channel).toBeDefined();
    expect('last_read' in channel!).toBe(false);
  });
});
