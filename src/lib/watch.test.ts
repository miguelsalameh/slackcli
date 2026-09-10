import { describe, expect, it } from 'bun:test';
import { RateLimiter } from './rate-limiter.ts';
import { SlackClient } from './slack-client.ts';
import {
  WATCH_READ_METHODS,
  WatchResolver,
  formatWatchLine,
  matchesWatchFilters,
  senderOf,
  watchEventText,
  watchMessages,
  type OpenWatchSocket,
  type ResolvedWatchEvent,
  type RtmMessageEvent,
  type WatchSocketHandlers,
} from './watch.ts';

const browserConfig = {
  workspace_id: 'T1',
  workspace_name: 'test',
  auth_type: 'browser' as const,
  workspace_url: 'https://test.slack.com',
  xoxc_token: 'xoxc-test',
  xoxd_token: 'xoxd-te st',
};

// Fails the test on any Web API method outside the read allowlist — this is the
// guard behind the command's read-only promise. Canned responses cover the
// lookups watch performs.
class ReadOnlySlackClient extends SlackClient {
  public readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(private readonly responses: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
    super(browserConfig, { rateLimiter: new RateLimiter({ maxConcurrent: 10, minIntervalMs: 0 }) });
  }

  override async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!(WATCH_READ_METHODS as readonly string[]).includes(method)) {
      throw new Error(`watch called a non-read-only method: ${method}`);
    }
    this.calls.push({ method, params });
    const respond = this.responses[method];
    if (!respond) throw new Error(`no canned response for ${method}`);
    return { ok: true, ...(respond(params) as object) };
  }
}

const cannedResponses = {
  'rtm.connect': () => ({ url: 'wss://example.test/socket' }),
  'users.info': (p: Record<string, unknown>) => ({ user: { id: p.user, name: 'ada', real_name: p.user === 'U2' ? 'Bob Byte' : 'Ada Lovelace' } }),
  'bots.info': (p: Record<string, unknown>) => ({ bot: { id: p.bot, name: 'CI Bot' } }),
  'conversations.info': (p: Record<string, unknown>) => {
    if (p.channel === 'D1') return { channel: { id: 'D1', is_im: true, user: 'U2' } };
    if (p.channel === 'G1') return { channel: { id: 'G1', is_mpim: true, name: 'mpdm-ada--bob-1' } };
    return { channel: { id: p.channel, name: 'general' } };
  },
  'conversations.history': () => ({ messages: [{ type: 'message', user: 'U2', text: 'root  message\nwith newline', ts: '1700000000.000100' }] }),
};

const message = (overrides: Partial<RtmMessageEvent> = {}): RtmMessageEvent => ({
  type: 'message',
  channel: 'C1',
  user: 'U1',
  text: 'hello',
  ts: '1700000001.000200',
  ...overrides,
});

describe('matchesWatchFilters', () => {
  it('passes a plain message with no filters', () => {
    expect(matchesWatchFilters(message())).toBe(true);
  });

  it('ignores non-message event types', () => {
    expect(matchesWatchFilters({ type: 'user_typing', channel: 'C1' })).toBe(false);
    expect(matchesWatchFilters({ type: 'hello' })).toBe(false);
  });

  it('hides edits, deletes and joins by default but keeps new-message subtypes', () => {
    expect(matchesWatchFilters(message({ subtype: 'message_changed' }))).toBe(false);
    expect(matchesWatchFilters(message({ subtype: 'message_deleted' }))).toBe(false);
    expect(matchesWatchFilters(message({ subtype: 'channel_join' }))).toBe(false);
    expect(matchesWatchFilters(message({ subtype: 'bot_message', user: undefined, bot_id: 'B1' }))).toBe(true);
    expect(matchesWatchFilters(message({ subtype: 'file_share' }))).toBe(true);
    expect(matchesWatchFilters(message({ subtype: 'thread_broadcast' }))).toBe(true);
    expect(matchesWatchFilters(message({ subtype: 'me_message' }))).toBe(true);
  });

  it('shows every subtype with includeSubtypes', () => {
    expect(matchesWatchFilters(message({ subtype: 'message_changed' }), { includeSubtypes: true })).toBe(true);
    expect(matchesWatchFilters(message({ subtype: 'channel_join' }), { includeSubtypes: true })).toBe(true);
  });

  it('botsOnly keeps bot_id or bot_message events and drops humans', () => {
    expect(matchesWatchFilters(message(), { botsOnly: true })).toBe(false);
    expect(matchesWatchFilters(message({ bot_id: 'B1' }), { botsOnly: true })).toBe(true);
    expect(matchesWatchFilters(message({ user: undefined, subtype: 'bot_message' }), { botsOnly: true })).toBe(true);
  });

  it('restricts to channels', () => {
    expect(matchesWatchFilters(message(), { channels: ['C1', 'C2'] })).toBe(true);
    expect(matchesWatchFilters(message({ channel: 'C3' }), { channels: ['C1', 'C2'] })).toBe(false);
    expect(matchesWatchFilters(message({ channel: undefined }), { channels: ['C1'] })).toBe(false);
  });

  it('an empty channel list means no restriction', () => {
    expect(matchesWatchFilters(message(), { channels: [] })).toBe(true);
    expect(matchesWatchFilters(message(), { from: [] })).toBe(true);
  });

  it('restricts to senders by user or bot id', () => {
    expect(matchesWatchFilters(message(), { from: ['U1'] })).toBe(true);
    expect(matchesWatchFilters(message(), { from: ['U9'] })).toBe(false);
    expect(matchesWatchFilters(message({ user: undefined, bot_id: 'B1' }), { from: ['B1'] })).toBe(true);
    expect(matchesWatchFilters(message({ user: undefined, bot_id: undefined, username: 'x' }), { from: ['U1'] })).toBe(false);
  });

  it('reads the sender out of an edit envelope', () => {
    const edit = message({ subtype: 'message_changed', user: undefined, message: { user: 'U7', text: 'edited' } });
    expect(senderOf(edit).user).toBe('U7');
    expect(matchesWatchFilters(edit, { includeSubtypes: true, from: ['U7'] })).toBe(true);
    expect(matchesWatchFilters(edit, { includeSubtypes: true, from: ['U1'] })).toBe(false);
  });

  it('combines filters with AND', () => {
    const filters = { botsOnly: true, channels: ['C1'], from: ['B1'] };
    expect(matchesWatchFilters(message({ user: undefined, bot_id: 'B1' }), filters)).toBe(true);
    expect(matchesWatchFilters(message({ user: undefined, bot_id: 'B2' }), filters)).toBe(false);
    expect(matchesWatchFilters(message({ user: undefined, bot_id: 'B1', channel: 'C2' }), filters)).toBe(false);
  });
});

describe('watchEventText', () => {
  it('prefers text, then edit-envelope text, then a file count', () => {
    expect(watchEventText(message())).toBe('hello');
    expect(watchEventText(message({ text: undefined, message: { text: 'edited' } }))).toBe('edited');
    expect(watchEventText(message({ text: '', files: [{}, {}] }))).toBe('<2 file(s)>');
    expect(watchEventText(message({ text: undefined }))).toBe('');
  });
});

describe('formatWatchLine', () => {
  const resolved = (overrides: Partial<ResolvedWatchEvent> = {}): ResolvedWatchEvent => ({
    ...message(),
    channel_name: '#general',
    user_name: 'Ada Lovelace',
    ts_iso: '2023-11-14T22:13:21.000Z',
    ...overrides,
  });

  it('renders time | channel | sender: text on one line', () => {
    const line = formatWatchLine(resolved());
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2} \| #general \| Ada Lovelace: hello$/);
  });

  it('tags the subtype after the sender', () => {
    expect(formatWatchLine(resolved({ subtype: 'bot_message' }))).toContain('Ada Lovelace (bot_message): hello');
  });

  it('flattens multi-line text so one message stays one line', () => {
    expect(formatWatchLine(resolved({ text: 'line one\n\n  line two' }))).toEndWith('Ada Lovelace: line one line two');
  });

  it('shows a file count when there is no text', () => {
    expect(formatWatchLine(resolved({ text: '', files: [{}] }))).toEndWith(': <1 file(s)>');
  });

  it('adds an indented thread line with the trimmed parent', () => {
    const line = formatWatchLine(resolved({
      thread_ts: '1700000000.000100',
      parent: { ts: '1700000000.000100', user_name: 'Bob Byte', text: 'x'.repeat(100) },
    }));
    const [first, second] = line.split('\n');
    expect(first).toContain('| #general | Ada Lovelace: hello');
    expect(second).toMatch(/^ {4}↳ reply in thread of \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2} Bob Byte: x{77}\.\.\.$/);
  });
});

describe('WatchResolver', () => {
  it('resolves users, bots, DMs, group DMs and channels, caching each lookup', async () => {
    const client = new ReadOnlySlackClient(cannedResponses);
    const resolver = new WatchResolver(client);

    expect(await resolver.channel('C1')).toBe('#general');
    expect(await resolver.channel('D1')).toBe('DM with Bob Byte');
    expect(await resolver.channel('G1')).toBe('group DM mpdm-ada--bob-1');
    expect(await resolver.bot('B1')).toBe('CI Bot');
    expect(await resolver.user('U2')).toBe('Bob Byte');
    await resolver.channel('C1');
    await resolver.user('U2');

    const methods = client.calls.map((c) => c.method).sort();
    // U2 is looked up once even though the DM resolution needed it too.
    expect(methods).toEqual(['bots.info', 'conversations.info', 'conversations.info', 'conversations.info', 'users.info']);
  });

  it('falls back to the raw id when a lookup fails', async () => {
    const client = new ReadOnlySlackClient({});
    const resolver = new WatchResolver(client);
    expect(await resolver.user('U404')).toBe('U404');
    expect(await resolver.channel('C404')).toBe('C404');
    expect(await resolver.bot('B404')).toBe('B404');
  });

  it('uses the username when a message has neither user nor bot id', async () => {
    const resolver = new WatchResolver(new ReadOnlySlackClient(cannedResponses));
    expect(await resolver.sender(message({ user: undefined, username: 'webhook' }))).toBe('webhook');
    expect(await resolver.sender(message({ user: undefined }))).toBe('?');
  });

  it('attaches the thread parent for replies, fetched once per thread', async () => {
    const client = new ReadOnlySlackClient(cannedResponses);
    const resolver = new WatchResolver(client);
    const reply = message({ thread_ts: '1700000000.000100' });

    const first = await resolver.resolve(reply);
    const second = await resolver.resolve({ ...reply, ts: '1700000002.000300' });

    expect(first.parent).toEqual({ ts: '1700000000.000100', user_name: 'Bob Byte', text: 'root  message\nwith newline' });
    expect(second.parent).toEqual(first.parent);
    expect(first.channel_name).toBe('#general');
    expect(first.user_name).toBe('Ada Lovelace');
    expect(first.ts_iso).toBe('2023-11-14T22:13:21.000Z');

    const history = client.calls.filter((c) => c.method === 'conversations.history');
    expect(history).toHaveLength(1);
    expect(history[0].params).toEqual({
      channel: 'C1',
      latest: '1700000000.000100',
      oldest: '1700000000.000100',
      inclusive: true,
      limit: 1,
    });
  });

  it('does not treat a thread root as a reply', async () => {
    const client = new ReadOnlySlackClient(cannedResponses);
    const root = await new WatchResolver(client).resolve(message({ thread_ts: '1700000001.000200' }));
    expect(root.parent).toBeUndefined();
    expect(client.calls.some((c) => c.method === 'conversations.history')).toBe(false);
  });
});

// A scripted socket: the test decides what the server "sends" and when it closes.
function fakeSocketFactory() {
  const sockets: Array<{ url: string; headers: Record<string, string>; handlers: WatchSocketHandlers; sent: string[]; closed: boolean }> = [];
  const open: OpenWatchSocket = (url, headers, handlers) => {
    const entry = { url, headers, handlers, sent: [] as string[], closed: false };
    sockets.push(entry);
    return {
      send: (d) => entry.sent.push(d),
      close: () => { entry.closed = true; queueMicrotask(() => handlers.onClose()); },
    };
  };
  return { sockets, open };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('watchMessages', () => {
  it('connects with the session cookie, emits filtered, resolved events, and stops on abort', async () => {
    const client = new ReadOnlySlackClient(cannedResponses);
    const { sockets, open } = fakeSocketFactory();
    const events: ResolvedWatchEvent[] = [];
    let connected = 0;
    const controller = new AbortController();

    const run = watchMessages(client, {
      filters: { channels: ['C1'] },
      signal: controller.signal,
      openSocket: open,
      pingIntervalMs: 0,
      onEvent: (e) => events.push(e),
      onConnected: () => connected++,
    });
    await tick();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('wss://example.test/socket');
    expect(sockets[0].headers.Cookie).toBe('d=xoxd-te%20st');

    sockets[0].handlers.onMessage(JSON.stringify({ type: 'hello' }));
    sockets[0].handlers.onMessage('not json');
    sockets[0].handlers.onMessage(JSON.stringify(message({ channel: 'C9', text: 'filtered out' })));
    sockets[0].handlers.onMessage(JSON.stringify(message({ text: 'first' })));
    sockets[0].handlers.onMessage(JSON.stringify(message({ text: 'second', ts: '1700000002.000000' })));

    controller.abort();
    await run;

    expect(connected).toBe(1);
    expect(events.map((e) => e.text)).toEqual(['first', 'second']);
    expect(events[0].channel_name).toBe('#general');
    expect(events[0].user_name).toBe('Ada Lovelace');
    expect(sockets[0].closed).toBe(true);
  });

  it('reconnects with backoff after the socket drops, then stops at the duration', async () => {
    const client = new ReadOnlySlackClient(cannedResponses);
    const { sockets, open } = fakeSocketFactory();
    const status: string[] = [];

    const run = watchMessages(client, {
      durationMs: 60,
      openSocket: open,
      pingIntervalMs: 0,
      backoffMs: 5,
      onEvent: () => {},
      onStatus: (m) => status.push(m),
    });
    await tick();
    sockets[0].handlers.onMessage(JSON.stringify({ type: 'hello' }));
    sockets[0].handlers.onClose();
    await run;

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(status.some((m) => m.startsWith('Disconnected'))).toBe(true);
    expect(client.calls.filter((c) => c.method === 'rtm.connect').length).toBe(sockets.length);
  });

  it('sends keepalive pings on the interval', async () => {
    const client = new ReadOnlySlackClient(cannedResponses);
    const { sockets, open } = fakeSocketFactory();
    const run = watchMessages(client, { durationMs: 40, openSocket: open, pingIntervalMs: 10, onEvent: () => {} });
    await run;
    expect(sockets[0].sent.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ id: 1, type: 'ping' });
  });

  it('rejects when the first rtm.connect fails', async () => {
    const client = new ReadOnlySlackClient({});
    await expect(watchMessages(client, { openSocket: fakeSocketFactory().open, onEvent: () => {} }))
      .rejects.toThrow('no canned response for rtm.connect');
  });

  it('never calls a write method — even a hostile event cannot make it', async () => {
    const client = new ReadOnlySlackClient(cannedResponses);
    const { sockets, open } = fakeSocketFactory();
    const controller = new AbortController();
    const run = watchMessages(client, {
      filters: { includeSubtypes: true },
      signal: controller.signal,
      openSocket: open,
      pingIntervalMs: 0,
      onEvent: () => {},
    });
    await tick();
    sockets[0].handlers.onMessage(JSON.stringify(message({ subtype: 'message_changed', thread_ts: '1700000000.000100', bot_id: 'B1', files: [{}] })));
    sockets[0].handlers.onMessage(JSON.stringify(message({ channel: 'D1', text: '' })));
    controller.abort();
    await run;

    const methods = new Set(client.calls.map((c) => c.method));
    for (const m of methods) expect(WATCH_READ_METHODS as readonly string[]).toContain(m);
    expect(methods.size).toBeGreaterThan(1);
  });
});
