import { describe, expect, it } from 'bun:test';
import { createConversationsCommand } from './conversations.ts';

function subcommand(name: string) {
  return createConversationsCommand().commands.find((command) => command.name() === name);
}

function longOptions(name: string): string[] {
  return (subcommand(name)?.options ?? []).map((option) => option.long ?? '');
}

function argumentNames(name: string): Array<{ name: string; required: boolean }> {
  return (subcommand(name)?.registeredArguments ?? []).map((argument) => ({
    name: argument.name(),
    required: argument.required,
  }));
}

describe('conversations command', () => {
  // The positionals became optional so --permalink can supply them; the requirement
  // is enforced in resolveMessageTarget / resolveThreadTarget instead, which is what
  // produces the "Missing <channel-id>" error when neither form is given.
  it('makes read take an optional channel positional plus --permalink', () => {
    expect(argumentNames('read')).toEqual([{ name: 'channel-id', required: false }]);
    expect(longOptions('read')).toContain('--permalink');
  });

  it('makes get take optional channel and timestamp positionals plus --permalink', () => {
    expect(argumentNames('get')).toEqual([
      { name: 'channel-id', required: false },
      { name: 'timestamp', required: false },
    ]);
    expect(longOptions('get')).toContain('--permalink');
  });

  it('keeps the range-bound options on read', () => {
    expect(longOptions('read')).toContain('--oldest');
    expect(longOptions('read')).toContain('--latest');
    expect(longOptions('read')).toContain('--thread-ts');
  });

  it('exposes --unread on read, defaulting to off', () => {
    const unreadOption = subcommand('read')?.options.find((option) => option.long === '--unread');
    expect(unreadOption).toBeDefined();
    expect(unreadOption?.defaultValue).toBe(false);
  });

  it('exposes --json on list, defaulting to off', () => {
    const jsonOption = subcommand('list')?.options.find((option) => option.long === '--json');
    expect(jsonOption).toBeDefined();
    expect(jsonOption?.defaultValue).toBe(false);
  });
});

describe('conversations watch', () => {
  it('exposes the filter, duration and json options', () => {
    expect(longOptions('watch')).toEqual(expect.arrayContaining([
      '--duration', '--channel', '--from', '--bots', '--include-subtypes', '--workspace', '--json',
    ]));
  });

  it('makes --channel and --from repeatable, defaulting to empty', () => {
    for (const flag of ['--channel', '--from']) {
      const option = subcommand('watch')?.options.find((o) => o.long === flag);
      expect(option?.defaultValue).toEqual([]);
      expect(option?.variadic).toBe(false);
    }
  });

  it('defaults --bots, --include-subtypes and --json to off', () => {
    for (const flag of ['--bots', '--include-subtypes', '--json']) {
      expect(subcommand('watch')?.options.find((o) => o.long === flag)?.defaultValue).toBe(false);
    }
  });
});
