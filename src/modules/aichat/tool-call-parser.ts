export interface ParsedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ParseToolCallsResult {
  toolCalls: ParsedToolCall[];
  cleanedContent: string;
}

export type ToolCallParserLogger = {
  warn: (message: string) => void;
};

const TOOL_CALL_PREFIX = /^functions\.[a-zA-Z_][a-zA-Z0-9_]*:\d+\s*\{/;

interface RawMatch {
  start: number;
  end: number;
  name: string;
  index: string;
  rawJson: string;
}

function findMatchingBrace(content: string, jsonStart: number): number {
  let depth = 1;
  let inString = false;
  let escapeNext = false;

  for (let i = jsonStart + 1; i < content.length; i++) {
    const ch = content[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function collectMatches(content: string): RawMatch[] {
  const regex = /functions\.([a-zA-Z_][a-zA-Z0-9_]*):(\d+)(\s*)\{/g;
  const matches: RawMatch[] = [];
  let result: RegExpExecArray | null = regex.exec(content);
  while (result !== null) {
    const fullMatch = result[0];
    if (!TOOL_CALL_PREFIX.test(fullMatch)) {
      result = regex.exec(content);
      continue;
    }
    const prefixLen = fullMatch.length;
    const jsonStart = result.index + prefixLen - 1;
    const jsonEnd = findMatchingBrace(content, jsonStart);
    if (jsonEnd === -1) {
      result = regex.exec(content);
      continue;
    }
    matches.push({
      start: result.index,
      end: jsonEnd,
      name: result[1],
      index: result[2],
      rawJson: content.substring(jsonStart, jsonEnd + 1),
    });
    result = regex.exec(content);
  }
  return matches;
}

export function parseToolCallsFromContent(
  content: string,
  logger?: ToolCallParserLogger
): ParseToolCallsResult {
  if (!content) {
    return { toolCalls: [], cleanedContent: '' };
  }

  const matches = collectMatches(content);
  if (matches.length === 0) {
    return { toolCalls: [], cleanedContent: content };
  }

  let cleaned = content;
  const toolCalls: ParsedToolCall[] = [];

  for (let i = matches.length - 1; i >= 0; i--) {
    const entry = matches[i];
    let argumentsStr = entry.rawJson;
    try {
      JSON.parse(entry.rawJson);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger?.warn(
        `[parseToolCallsFromContent] failed to parse JSON for functions.${entry.name}:${entry.index}: ${detail}`
      );
      argumentsStr = '{}';
    }
    toolCalls.unshift({
      id: `call_${entry.index}`,
      type: 'function',
      function: {
        name: entry.name,
        arguments: argumentsStr,
      },
    });
    cleaned =
      cleaned.substring(0, entry.start) + cleaned.substring(entry.end + 1);
  }

  return {
    toolCalls,
    cleanedContent: cleaned.trim(),
  };
}
