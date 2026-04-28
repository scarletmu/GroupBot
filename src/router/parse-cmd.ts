import parseArgsString from 'string-argv';

export interface ParsedCommand {
  cmd: string;
  argv: string[];
}

export function parseCommand(commandText: string): ParsedCommand | null {
  const trimmed = commandText.trim();
  if (!trimmed) return null;
  const tokens = parseArgsString(trimmed);
  if (tokens.length === 0) return null;
  const [cmd, ...argv] = tokens;
  if (!cmd) return null;
  return { cmd: cmd.toLowerCase(), argv };
}
