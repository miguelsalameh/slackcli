# Conversations

`slackcli conversations` covers channels, DMs, and group DMs: listing them,
reading history and threads, fetching one message, seeing what is unread, and
watching new messages arrive live.

Every subcommand accepts `--workspace <id|name>`.

## `conversations list`

```bash
slackcli conversations list                          # everything you are in
slackcli conversations list --types=public_channel
slackcli conversations list --types=im               # DMs only
slackcli conversations list --limit=200 --exclude-archived

# Machine-readable
slackcli conversations list --json
```

| Option | Default | Purpose |
|---|---|---|
| `--types <types>` | `public_channel,private_channel,mpim,im` | Comma-separated conversation types |
| `--limit <number>` | `100` | How many to return |
| `--exclude-archived` | off | Skip archived conversations |
| `--cursor <cursor>` | — | Fetch the next page |
| `--json` | off | JSON output with a resolved `users` array |

DM entries are resolved to the other person's name. When more results exist, the
exact `--cursor` command for the next page is printed (human output) or set on
`next_cursor` (`--json`; `null` on the last page).

## `conversations read`

Read channel history, or one thread.

```bash
# Recent messages in a channel (oldest first)
slackcli conversations read C1234567890

# One thread
slackcli conversations read C1234567890 --thread-ts=1234567890.123456

# The thread a message link points at
slackcli conversations read --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456"

# Top-level messages only
slackcli conversations read C1234567890 --exclude-replies

# A time window
slackcli conversations read C1234567890 --oldest=1735689600 --latest=1738368000

# Machine-readable
slackcli conversations read C1234567890 --json
```

| Option | Default | Purpose |
|---|---|---|
| `--thread-ts <ts>` | — | Read a specific thread instead of the channel |
| `--permalink <url>` | — | Replaces the channel argument and `--thread-ts` |
| `--exclude-replies` | off | Drop threaded replies from channel history |
| `--limit <number>` | `100` | How many messages |
| `--oldest` / `--latest` | — | Time range bounds |
| `--json` | off | JSON output, including `ts` and `thread_ts` |

Channel history comes back newest-first from Slack and is reversed so you read
top to bottom. Thread replies are already chronological. `--json` also includes
reactions, blocks, attachments, file metadata, and a resolved `users` array.

## `conversations get`

Fetch one message by channel and timestamp.

```bash
slackcli conversations get C1234567890 1234567890.123456
slackcli conversations get --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456"
slackcli conversations get C1234567890 p1234567890123456 --json
```

**Auth-type caveat.** With browser auth this resolves both top-level messages and
thread replies. With a standard token it can only resolve **top-level** messages
— looking up an arbitrary reply needs its parent's `thread_ts`, and no public
Slack API returns that from a reply timestamp alone. Read the thread instead:
`conversations read <channel> --thread-ts=<parent>`.

## `conversations unread`

```bash
slackcli conversations unread
slackcli conversations unread --types=dms          # channels, dms, groups
slackcli conversations unread --json
```

Conversations with mentions sort first, then alphabetically. On a workspace with
many unread channels this makes one API call per channel to resolve names and
may hit Slack rate limits.

## `conversations watch`

Stream new messages as they arrive, instead of re-running `read` or `unread` on
a timer. Runs until Ctrl-C or `--duration` elapses.

```bash
slackcli conversations watch                              # everything, until Ctrl-C
slackcli conversations watch --duration=300               # five minutes
slackcli conversations watch --channel=C1234567890 --channel="$LINK"
slackcli conversations watch --bots                       # only bot posts
slackcli conversations watch --from=U0123456789 --from=B0123456789
slackcli conversations watch --include-subtypes           # also edits, deletes, joins

# Machine-readable: one JSON object per line
slackcli conversations watch --json | jq -r '"\(.channel_name)\t\(.user_name)\t\(.text)"'
```

| Option | Default | Purpose |
|---|---|---|
| `--duration <seconds>` | until Ctrl-C | Stop after this long |
| `--channel <id>` | all | Only this channel ID or Slack URL; repeat for several |
| `--from <id>` | all | Only this sender — a user (`U…`) or bot (`B…`) ID; repeat for several |
| `--bots` | off | Only messages with a bot sender |
| `--include-subtypes` | off | Also show edits, deletions, joins and other subtypes |
| `--json` | off | NDJSON: the raw Slack event plus resolved names |

Each message is one line:

```
09/10/2026, 12:51:18 | #octopus | Confluence (bot_message): Arne needs access to view your link.
09/10/2026, 12:52:02 | DM with Ada Lovelace | Ada Lovelace: on my way
09/10/2026, 12:52:40 | #incidents | Bob Byte: rolled back
    ↳ reply in thread of 09/10/2026, 12:40:11 Ada Lovelace: deploy 4.2 is failing health checks
```

Times are local. Senders, channels, DMs and bots are resolved to names (one
lookup each, cached for the run); a thread reply shows its parent message on an
indented second line, fetched once per thread. Multi-line text is flattened so a
message stays one line; a message with files and no text shows `<N file(s)>`.

By default only new posts are shown: plain messages plus the `bot_message`,
`file_share`, `thread_broadcast` and `me_message` subtypes. Edits
(`message_changed`), deletions, channel joins and the like are hidden unless you
pass `--include-subtypes`, in which case every subtype is shown and tagged after
the sender. Filters combine with AND and are applied client-side.

`--json` writes one object per line to stdout: the Slack event as received, plus
`channel_name`, `user_name`, `ts_iso`, and for a thread reply a `parent` object
(`ts`, `user_name`, `text`). Connection notices go to stderr, so a pipe carries
only events.

**Read-only, browser auth.** `watch` uses the same session credentials as every
other command — the `xoxc` token and `xoxd` cookie — over Slack's `rtm.connect`
websocket. No Slack app, Socket Mode, or admin approval is involved. It only
ever reads: the only API calls it makes are `rtm.connect`, `conversations.info`,
`users.info`, `bots.info`, and `conversations.history` (for thread parents), and
this is enforced by a test. It never sends, reacts, or marks anything read, so
watching leaves your unread state untouched. Standard `xoxb`/`xoxp` app tokens
are refused by `rtm.connect`; sign in with `auth login-auto` or `auth
login-browser` to use it. If the socket drops, `watch` reconnects with backoff
and keeps going; a keepalive ping is sent every 30 seconds.
