/**
 * Live, READ-ONLY message stream over Slack's RTM websocket.
 *
 * `rtm.connect` accepts the same browser-session credentials the rest of the CLI
 * stores (xoxc token in the body, `d=<xoxd>` cookie on the call and on the
 * websocket upgrade), so no Slack app or Socket Mode is involved. This module
 * only ever reads: the Slack Web API methods it touches are listed in
 * `WATCH_READ_METHODS`, and `watch.test.ts` fails on anything outside that list.
 */

import chalk from 'chalk';
import { formatTimestamp } from './formatter.ts';
import type { SlackClient } from './slack-client.ts';

/** Every Web API method the watch path is allowed to call. Nothing here writes. */
export const WATCH_READ_METHODS = [
  'rtm.connect',
  'conversations.info',
  'users.info',
  'bots.info',
  'conversations.history',
] as const;

/** A `message` event as delivered over the websocket. Only the fields watch reads are typed. */
export interface RtmMessageEvent {
  type: string;
  subtype?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: unknown[];
  /** Present on `message_changed` / `message_deleted`: the affected message. */
  message?: { text?: string; user?: string; bot_id?: string; username?: string; files?: unknown[] };
  [key: string]: unknown;
}

export interface WatchFilters {
  /** Only events with a bot_id or subtype bot_message. */
  botsOnly?: boolean;
  /** Only these channel IDs. */
  channels?: string[];
  /** Only these sender IDs (U…/W… users or B… bots). */
  from?: string[];
  /** Also pass edits, deletes, joins and other non-message subtypes. */
  includeSubtypes?: boolean;
}

// Subtypes that still mean "someone posted something new". Anything else
// (message_changed, message_deleted, channel_join, …) is noise on a live feed
// unless --include-subtypes asks for it.
const NEW_MESSAGE_SUBTYPES = new Set(['bot_message', 'file_share', 'thread_broadcast', 'me_message']);

/** Who produced the event, looking inside `message` for edit/delete envelopes. */
export function senderOf(event: RtmMessageEvent): { user?: string; bot_id?: string; username?: string } {
  const inner = event.message;
  return {
    user: event.user ?? inner?.user,
    bot_id: event.bot_id ?? inner?.bot_id,
    username: event.username ?? inner?.username,
  };
}

/** True when the event passes every configured filter. Pure; no network. */
export function matchesWatchFilters(event: RtmMessageEvent, filters: WatchFilters = {}): boolean {
  if (event.type !== 'message') return false;
  if (!filters.includeSubtypes && event.subtype && !NEW_MESSAGE_SUBTYPES.has(event.subtype)) return false;

  const sender = senderOf(event);
  if (filters.botsOnly && !sender.bot_id && event.subtype !== 'bot_message') return false;
  if (filters.channels?.length && !filters.channels.includes(event.channel ?? '')) return false;
  if (filters.from?.length) {
    const ids = [sender.user, sender.bot_id].filter((id): id is string => !!id);
    if (!ids.some((id) => filters.from!.includes(id))) return false;
  }
  return true;
}

/** Display text for an event: its text, else a file count, else empty. */
export function watchEventText(event: RtmMessageEvent): string {
  const text = event.text || event.message?.text;
  if (text) return text;
  const files = event.files ?? event.message?.files;
  if (files?.length) return `<${files.length} file(s)>`;
  return '';
}

export interface WatchParent {
  ts: string;
  user_name: string;
  text: string;
}

/** An event plus the names watch resolved for it. This is the `--json` shape. */
export interface ResolvedWatchEvent extends RtmMessageEvent {
  channel_name: string;
  user_name: string;
  ts_iso: string;
  parent?: WatchParent;
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** The human-mode line(s) for one event. Pure; no network. */
export function formatWatchLine(event: ResolvedWatchEvent): string {
  const subtype = event.subtype ? chalk.dim(` (${event.subtype})`) : '';
  const time = chalk.dim(formatTimestamp(event.ts ?? '0'));
  let line = `${time} | ${chalk.cyan(event.channel_name)} | ${chalk.bold(event.user_name)}${subtype}: ${oneLine(watchEventText(event), Infinity)}`;
  if (event.parent) {
    const parentTime = formatTimestamp(event.parent.ts);
    line += `\n    ${chalk.dim(`↳ reply in thread of ${parentTime} ${event.parent.user_name}: ${oneLine(event.parent.text)}`)}`;
  }
  return line;
}

/**
 * Resolves IDs to names with one in-process cache per kind, so a busy channel
 * costs one `users.info` per distinct sender rather than one per message.
 * Lookups that fail fall back to the raw ID; a name is decoration, not data.
 */
export class WatchResolver {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(private readonly client: SlackClient) {}

  private memo<T>(key: string, fallback: T, load: () => Promise<T>): Promise<T> {
    let hit = this.cache.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load().catch(() => fallback);
      this.cache.set(key, hit);
    }
    return hit;
  }

  user(id: string): Promise<string> {
    return this.memo(`user:${id}`, id, async () => {
      const u = (await this.client.getUserInfo(id)).user;
      return u?.real_name || u?.name || id;
    });
  }

  bot(id: string): Promise<string> {
    return this.memo(`bot:${id}`, id, async () => (await this.client.getBotInfo(id)).bot?.name || id);
  }

  channel(id: string): Promise<string> {
    return this.memo(`channel:${id}`, id, async () => {
      const c = (await this.client.getConversationInfo(id)).channel;
      if (c?.is_im) return `DM with ${await this.user(c.user)}`;
      if (c?.is_mpim) return `group DM ${c.name ?? id}`;
      return `#${c?.name ?? id}`;
    });
  }

  sender(event: RtmMessageEvent): Promise<string> {
    const { user, bot_id, username } = senderOf(event);
    if (user) return this.user(user);
    if (bot_id) return this.bot(bot_id);
    return Promise.resolve(username ?? '?');
  }

  /** The root message of a thread, fetched once per thread. */
  parent(channel: string, threadTs: string): Promise<WatchParent | undefined> {
    return this.memo(`parent:${channel}:${threadTs}`, undefined, async () => {
      const history = await this.client.getConversationHistory(channel, {
        latest: threadTs,
        oldest: threadTs,
        inclusive: true,
        limit: 1,
      });
      const root = history.messages?.[0];
      if (!root) return undefined;
      return {
        ts: threadTs,
        user_name: await this.sender(root),
        text: watchEventText(root) || '<no text>',
      };
    });
  }

  async resolve(event: RtmMessageEvent): Promise<ResolvedWatchEvent> {
    const channel = event.channel ?? '';
    const isReply = !!event.thread_ts && event.thread_ts !== event.ts;
    const [channel_name, user_name, parent] = await Promise.all([
      this.channel(channel),
      this.sender(event),
      isReply ? this.parent(channel, event.thread_ts!) : Promise.resolve(undefined),
    ]);
    return {
      ...event,
      channel_name,
      user_name,
      ts_iso: new Date(Number(event.ts ?? 0) * 1000).toISOString(),
      ...(parent ? { parent } : {}),
    };
  }
}

/** The slice of a websocket the stream needs; a seam so tests run without a network. */
export interface WatchSocket {
  send(data: string): void;
  close(): void;
}

export interface WatchSocketHandlers {
  onMessage(data: string): void;
  onClose(): void;
  onError(error: unknown): void;
}

export type OpenWatchSocket = (url: string, headers: Record<string, string>, handlers: WatchSocketHandlers) => WatchSocket;

// Bun's global WebSocket takes `{ headers }` as its second argument, which is
// how the `d` session cookie rides along on the upgrade request.
const openBunSocket: OpenWatchSocket = (url, headers, handlers) => {
  const ws = new WebSocket(url, { headers });
  ws.onmessage = (e) => handlers.onMessage(String(e.data));
  ws.onclose = () => handlers.onClose();
  ws.onerror = (e) => handlers.onError(e);
  return { send: (d) => ws.send(d), close: () => ws.close() };
};

export interface WatchOptions {
  filters?: WatchFilters;
  /** Stop after this long. Omitted: run until `signal` aborts. */
  durationMs?: number;
  signal?: AbortSignal;
  onEvent: (event: ResolvedWatchEvent) => void;
  /** Fired on every `hello`, i.e. on the first connection and after each reconnect. */
  onConnected?: () => void;
  /** Trouble notices (socket dropped, reconnecting). Callers route these to stderr. */
  onStatus?: (message: string) => void;
  /** Transport seam. Defaults to Bun's WebSocket. */
  openSocket?: OpenWatchSocket;
  /** Slack drops idle sockets; a client ping every so often keeps it open. 0 disables. */
  pingIntervalMs?: number;
  /** First reconnect delay; doubles per failure up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * Stream live message events until the duration elapses or `signal` aborts,
 * reconnecting with exponential backoff whenever the socket drops. Resolves
 * when the stream stops; rejects only if the very first `rtm.connect` fails.
 */
export async function watchMessages(client: SlackClient, options: WatchOptions): Promise<void> {
  const {
    filters = {},
    onEvent,
    onConnected = () => {},
    onStatus = () => {},
    openSocket = openBunSocket,
    pingIntervalMs = 30_000,
    backoffMs = 1_000,
    maxBackoffMs = 30_000,
  } = options;
  const resolver = new WatchResolver(client);
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  const deadline = options.durationMs !== undefined ? setTimeout(stop, options.durationMs) : undefined;
  const stopped = () => controller.signal.aborted;

  // Events resolve names asynchronously; a promise chain keeps output in arrival order.
  let queue: Promise<void> = Promise.resolve();

  let attempt = 0;
  try {
    while (!stopped()) {
      let url: string;
      try {
        url = (await client.rtmConnect()).url;
      } catch (error) {
        if (attempt === 0) throw error;
        await backoff(error);
        continue;
      }

      await new Promise<void>((resolve) => {
        let pingId = 0;
        let pinger: ReturnType<typeof setInterval> | undefined;
        const socket = openSocket(url, client.websocketHeaders(), {
          onMessage: (data) => {
            let event: RtmMessageEvent;
            try { event = JSON.parse(data); } catch { return; }
            if (event.type === 'hello') {
              attempt = 0;
              onConnected();
              return;
            }
            if (!matchesWatchFilters(event, filters)) return;
            queue = queue
              .then(() => resolver.resolve(event))
              .then(onEvent)
              .catch((error: unknown) => onStatus(`Could not render event: ${error instanceof Error ? error.message : String(error)}`));
          },
          onClose: () => { clearInterval(pinger); controller.signal.removeEventListener('abort', close); resolve(); },
          onError: (error) => onStatus(`Socket error: ${error instanceof Error ? error.message : 'connection failed'}`),
        });
        const close = () => socket.close();
        controller.signal.addEventListener('abort', close, { once: true });
        if (pingIntervalMs > 0) {
          pinger = setInterval(() => socket.send(JSON.stringify({ id: ++pingId, type: 'ping' })), pingIntervalMs);
        }
      });

      if (!stopped()) await backoff();
    }
    await queue;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', stop);
  }

  async function backoff(error?: unknown): Promise<void> {
    const delay = Math.min(backoffMs * 2 ** attempt, maxBackoffMs);
    attempt++;
    const why = error instanceof Error ? `: ${error.message}` : '';
    onStatus(`Disconnected${why}. Reconnecting in ${Math.round(delay / 1000)}s...`);
    await sleep(delay, controller.signal);
  }
}
