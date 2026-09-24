import chalk from 'chalk';
import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatChannelList, formatConversationHistory, formatUnreadChannels, warning, writeJson } from '../lib/formatter.ts';
import { fetchMessage } from '../lib/message.ts';
import { fetchUnreadChannels, resolveUnreadOldest } from '../lib/unread.ts';
import { formatWatchLine, watchMessages } from '../lib/watch.ts';
import {
  normalizeIdentifier,
  normalizeTimestamp,
  resolveMessageTarget,
  resolveThreadTarget,
  workspaceMismatchWarning,
  workspaceOf,
} from '../lib/slack-url-parser.ts';
import type { SlackClient } from '../lib/slack-client.ts';
import type { SlackChannel, SlackMessage, SlackUser } from '../types/index.ts';

// Warn when a pasted link points at a different workspace than the one we will call,
// rather than letting Slack answer with a misleading message_not_found.
function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

// rtm.connect refuses modern app tokens; say so instead of echoing Slack's code.
function watchHint(message: string): string | undefined {
  if (message.includes('not_allowed_token_type') || message.includes('invalid_auth')) {
    return 'Live watching needs browser-session credentials. Run "slackcli auth login-auto" or "slackcli auth login-browser".';
  }
  return undefined;
}

export function createConversationsCommand(): Command {
  const conversations = new Command('conversations')
    .description('Manage Slack conversations (channels, DMs, groups)');

  // List conversations
  conversations
    .command('list')
    .description('List all conversations')
    .option('--types <types>', 'Conversation types (comma-separated: public_channel,private_channel,mpim,im)', 'public_channel,private_channel,mpim,im')
    .option('--limit <number>', 'Number of conversations to return', '100')
    .option('--exclude-archived', 'Exclude archived conversations', false)
    .option('--cursor <cursor>', 'Pagination cursor for next page of results')
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching conversations...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.listConversations({
          types: options.types,
          limit: parseInt(options.limit),
          exclude_archived: options.excludeArchived,
          ...(options.cursor ? { cursor: options.cursor } : {}),
        });

        const channels: SlackChannel[] = response.channels || [];
        const nextCursor = response.response_metadata?.next_cursor;

        // Fetch user info for DMs
        const userIds = new Set<string>();
        channels.forEach(ch => {
          if (ch.is_im && ch.user) {
            userIds.add(ch.user);
          }
        });

        const users = new Map<string, SlackUser>();
        if (userIds.size > 0) {
          spinner.text = 'Fetching user information...';
          const usersResponse = await client.getUsersInfo(Array.from(userIds));
          usersResponse.users?.forEach((user: SlackUser) => {
            users.set(user.id, user);
          });
        }

        spinner.succeed(`Found ${channels.length} conversations`);

        // Slack returns next_cursor as '' rather than omitting it when there is no
        // next page; normalize to null so JSON consumers get a real sentinel.
        const jsonNextCursor = nextCursor || null;

        if (options.json) {
          writeJson({
            conversation_count: channels.length,
            conversations: channels.map(ch => ({
              id: ch.id,
              name: ch.name,
              user: ch.user,
              is_channel: ch.is_channel,
              is_group: ch.is_group,
              is_im: ch.is_im,
              is_mpim: ch.is_mpim,
              is_private: ch.is_private,
              is_archived: ch.is_archived,
              is_member: ch.is_member,
              num_members: ch.num_members,
              topic: ch.topic?.value,
              purpose: ch.purpose?.value,
            })),
            users: Array.from(users.values()).map(u => ({
              id: u.id,
              name: u.name,
              real_name: u.real_name,
              email: u.profile?.email,
            })),
            next_cursor: jsonNextCursor,
          });
          return;
        }

        console.log('\n' + formatChannelList(channels, users));

        if (nextCursor) {
          console.log(chalk.dim('\nMore results available. Next page:'));
          console.log(chalk.cyan(`  slackcli conversations list --cursor "${nextCursor}"\n`));
        }
      } catch (err: any) {
        spinner.fail('Failed to fetch conversations');
        error(err.message, 'Run "slackcli auth list" to check your authentication.');
        process.exit(1);
      }
    });

  // Read conversation history
  conversations
    .command('read')
    .description('Read conversation history or specific thread')
    .argument('[channel-id]', 'Channel ID or Slack URL to read from')
    .option('--thread-ts <timestamp>', 'Thread timestamp to read specific thread')
    .option('--permalink <url>', 'Slack link; reads that channel, or that message\'s thread (replaces <channel-id> and --thread-ts)')
    .option('--exclude-replies', 'Exclude threaded replies (only top-level messages)', false)
    .option('--limit <number>', 'Number of messages to return', '100')
    .option('--oldest <timestamp>', 'Start of time range')
    .option('--latest <timestamp>', 'End of time range')
    .option('--unread', 'Only messages after your last-read marker (sets --oldest from conversations.info)', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format (includes timestamps for replies)', false)
    .action(async (channelIdArg, options) => {
      const spinner = ora('Fetching messages...').start();

      try {
        const target = resolveThreadTarget(
          { permalink: options.permalink, channelId: channelIdArg, threadTs: options.threadTs },
          { channel: '<channel-id>', timestamp: '--thread-ts' }
        );
        const channelId = target.channelId;
        let oldest = options.oldest ? normalizeTimestamp(options.oldest, '--oldest') : undefined;
        const latest = options.latest ? normalizeTimestamp(options.latest, '--latest') : undefined;

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);

        if (options.unread) {
          oldest = await resolveUnreadOldest(client, channelId, { oldest, threadTs: target.threadTs });
        }

        let response: any;
        let messages: SlackMessage[];

        if (target.threadTs) {
          // Fetch thread replies
          spinner.text = 'Fetching thread replies...';
          response = await client.getConversationReplies(channelId, target.threadTs, {
            limit: parseInt(options.limit),
            oldest,
            latest,
          });
          messages = response.messages || [];
        } else {
          // Fetch conversation history
          spinner.text = 'Fetching conversation history...';
          response = await client.getConversationHistory(channelId, {
            limit: parseInt(options.limit),
            oldest,
            latest,
          });
          messages = response.messages || [];

          // Filter out replies if requested
          if (options.excludeReplies) {
            messages = messages.filter(msg => !msg.thread_ts || msg.thread_ts === msg.ts);
          }
        }

        // Channel history returns newest first, so reverse to show oldest first.
        // Thread replies already come in chronological order.
        if (!target.threadTs) {
          messages.reverse();
        }

        // Fetch user info for messages
        const userIds = new Set<string>();
        messages.forEach(msg => {
          if (msg.user) {
            userIds.add(msg.user);
          }
        });

        const users = new Map<string, SlackUser>();
        if (userIds.size > 0) {
          spinner.text = 'Fetching user information...';
          const usersResponse = await client.getUsersInfo(Array.from(userIds));
          usersResponse.users?.forEach((user: SlackUser) => {
            users.set(user.id, user);
          });
        }

        spinner.succeed(`Found ${messages.length} messages`);

        // Output in JSON format if requested
        if (options.json) {
          writeJson({
            channel_id: channelId,
            message_count: messages.length,
            messages: messages.map(msg => ({
              ts: msg.ts,
              thread_ts: msg.thread_ts,
              user: msg.user,
              text: msg.text,
              type: msg.type,
              reply_count: msg.reply_count,
              reactions: msg.reactions,
              bot_id: msg.bot_id,
              blocks: msg.blocks,
              attachments: msg.attachments,
              ...(msg.files?.length ? { files: msg.files.map(f => ({
                id: f.id,
                name: f.name,
                title: f.title,
                mimetype: f.mimetype,
                filetype: f.filetype,
                size: f.size,
                url_private: f.url_private,
                permalink: f.permalink,
                mode: f.mode,
              })) } : {}),
            })),
            users: Array.from(users.values()).map(u => ({
              id: u.id,
              name: u.name,
              real_name: u.real_name,
              email: u.profile?.email,
            })),
          });
        } else {
          console.log('\n' + formatConversationHistory(channelId, messages, users));
        }
      } catch (err: any) {
        spinner.fail('Failed to fetch messages');
        error(err.message);
        process.exit(1);
      }
    });

  // Get a single message by channel + timestamp
  conversations
    .command('get')
    .description('Get a specific message by channel ID and timestamp')
    .argument('[channel-id]', 'Channel ID or Slack URL')
    .argument('[timestamp]', 'Message timestamp (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link (replaces <channel-id> and <timestamp>)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (channelIdArg, timestampArg, options) => {
      const spinner = ora('Fetching message...').start();

      try {
        const target = resolveMessageTarget(
          { permalink: options.permalink, channelId: channelIdArg, timestamp: timestampArg },
          { channel: '<channel-id>', timestamp: '<timestamp>' }
        );
        const channelId = target.channelId;

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);

        const msg = await fetchMessage(client, channelId, target.timestamp);

        if (!msg) {
          spinner.fail('Message not found');
          process.exit(1);
        }

        // Fetch user info
        const users = new Map<string, SlackUser>();
        if (msg.user) {
          spinner.text = 'Fetching user information...';
          try {
            const userResponse = await client.getUserInfo(msg.user);
            if (userResponse.user) {
              users.set(userResponse.user.id, userResponse.user);
            }
          } catch {
            // Continue without user info
          }
        }

        spinner.succeed('Message found');

        if (options.json) {
          writeJson({
            channel_id: channelId,
            message: {
              ts: msg.ts,
              thread_ts: msg.thread_ts,
              user: msg.user,
              text: msg.text,
              type: msg.type,
              reply_count: msg.reply_count,
              reactions: msg.reactions,
              bot_id: msg.bot_id,
              blocks: msg.blocks,
              ...(msg.files?.length ? { files: msg.files.map(f => ({
                id: f.id,
                name: f.name,
                title: f.title,
                mimetype: f.mimetype,
                filetype: f.filetype,
                size: f.size,
                url_private: f.url_private,
                permalink: f.permalink,
                mode: f.mode,
              })) } : {}),
            },
            users: Array.from(users.values()).map(u => ({
              id: u.id,
              name: u.name,
              real_name: u.real_name,
              email: u.profile?.email,
            })),
          });
        } else {
          console.log('\n' + formatConversationHistory(channelId, [msg], users));
        }
      } catch (err: any) {
        spinner.fail('Failed to fetch message');
        error(err.message);
        process.exit(1);
      }
    });

  // Stream live messages over the RTM websocket (read-only)
  const collect = (value: string, previous: string[]) => [...previous, value];
  conversations
    .command('watch')
    .description('Stream new messages live over a websocket (read-only; browser auth). Ctrl-C to stop')
    .option('--duration <seconds>', 'Stop after this many seconds (default: run until Ctrl-C)')
    .option('--channel <id>', 'Only this channel ID or Slack URL (repeatable)', collect, [])
    .option('--from <id>', 'Only this sender: a user (U…) or bot (B…) ID, or a user URL (repeatable)', collect, [])
    .option('--bots', 'Only messages posted by bots', false)
    .option('--include-subtypes', 'Also show edits, deletions, joins and other message subtypes', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'One JSON object per line (NDJSON) with resolved names', false)
    .action(async (options) => {
      const spinner = ora('Connecting...').start();

      try {
        const channels = (options.channel as string[]).map((c) => normalizeIdentifier(c, 'channel', '--channel'));
        const from = (options.from as string[]).map((f) => normalizeIdentifier(f, 'user', '--from'));
        const duration = options.duration === undefined ? undefined : Number(options.duration);
        if (duration !== undefined && !(duration > 0)) {
          throw new Error('--duration must be a positive number of seconds');
        }

        const client = await getAuthenticatedClient(options.workspace);
        for (const input of options.channel as string[]) {
          warnOnWorkspaceMismatch(client, workspaceOf(input));
        }

        const controller = new AbortController();
        const onInterrupt = () => controller.abort();
        process.once('SIGINT', onInterrupt);
        process.once('SIGTERM', onInterrupt);

        let connected = false;
        await watchMessages(client, {
          filters: { channels, from, botsOnly: options.bots, includeSubtypes: options.includeSubtypes },
          durationMs: duration === undefined ? undefined : duration * 1000,
          signal: controller.signal,
          onConnected: () => {
            if (connected) {
              console.error(chalk.dim('Reconnected.'));
              return;
            }
            connected = true;
            spinner.succeed('Connected. Watching for messages (read-only) — Ctrl-C to stop.');
          },
          onStatus: warning,
          onEvent: (event) => {
            if (options.json) {
              process.stdout.write(JSON.stringify(event) + '\n');
            } else {
              console.log(formatWatchLine(event));
            }
          },
        });

        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onInterrupt);
        console.error(chalk.dim('Stopped watching.')); // stderr: stdout is the event stream
      } catch (err: any) {
        spinner.fail('Failed to watch conversations');
        const hint = watchHint(err.message);
        error(err.message, hint);
        process.exit(1);
      }
    });

  // List unread conversations
  conversations
    .command('unread')
    .description('List conversations with unread messages')
    .option('--types <types>', 'Filter by type (comma-separated: channels,dms,groups)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching unread counts...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        let channels = await fetchUnreadChannels(client, {
          onProgress: (msg) => { spinner.text = msg; },
        });

        // Apply type filter if specified
        if (options.types) {
          const types = options.types.split(',').map((t: string) => t.trim());
          channels = channels.filter(ch => {
            if (types.includes('channels') && !ch.is_im && !ch.is_mpim) return true;
            if (types.includes('dms') && ch.is_im) return true;
            if (types.includes('groups') && ch.is_mpim) return true;
            return false;
          });
        }

        if (channels.length === 0) {
          spinner.succeed('All caught up! No unread messages.');
          return;
        }

        spinner.succeed(`${channels.length} conversations with unread messages`);

        if (options.json) {
          writeJson({ unread_channels: channels });
          return;
        }

        console.log('\n' + formatUnreadChannels(channels));
      } catch (err: any) {
        spinner.fail('Failed to fetch unread conversations');
        error(err.message);
        process.exit(1);
      }
    });

  return conversations;
}
