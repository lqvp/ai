import got from 'got';
import config from '@/config/index.js';
import { getGeminiApiUrl } from './constants.js';
import { stripDangerousKeys } from './json-file-store.js';
import { getLlmUsageGuard } from './llm-usage-guard.js';
import {
  type OpenaiProviderConfig,
  resolveOpenaiSettings,
} from './openai-settings.js';
import { findMatchingBrace } from './tool-call-parser.js';

export type StructuredLlmCallOptions<T> = {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs?: number;
  temperature?: number;
  provider?: 'gemini' | 'openai';
  openaiConfig?: OpenaiProviderConfig & { jsonMode?: 'none' | 'json_object' };
  geminiConfig?: { apiKey?: string; apiUrl?: string };
  log?: (message: string) => void;
  parse: (obj: Record<string, unknown>) => T | null;
};

export function resolveProvider(
  override?: 'gemini' | 'openai'
): 'gemini' | 'openai' {
  return override ?? config.aiProvider?.provider ?? 'gemini';
}

/**
 * reasoning モデルが出力する <think>...</think> / 未閉鎖 <think> / prefill 由来の孤立 </think> を除去する。
 */
export function stripThinkingTags(raw: string): string {
  if (!raw) return '';

  // 1. 閉じた思考ブロックを除去
  let cleaned = raw.replace(
    /<(think|thought|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ''
  );

  // 2. プロンプト末尾で <think> を prefill する vLLM テンプレート対策: 最後の </think> 以降を採用
  const closingRe = /<\/(?:think|thought|reasoning)>/gi;
  let lastCloseEnd = -1;
  let match: RegExpExecArray | null = closingRe.exec(cleaned);
  while (match !== null) {
    lastCloseEnd = match.index + match[0].length;
    match = closingRe.exec(cleaned);
  }
  if (lastCloseEnd !== -1) {
    cleaned = cleaned.slice(lastCloseEnd);
  }

  // 3. 途中で打ち切られた未閉鎖 <think> が残っている場合はそこから末尾まで切り捨てる
  const openMatch = /<(?:think|thought|reasoning)\b[^>]*>/i.exec(cleaned);
  if (openMatch) {
    cleaned = cleaned.slice(0, openMatch.index);
  }

  return cleaned.trim();
}

function tryParsePlainObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return stripDangerousKeys(parsed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 文字列外で末尾カンマを除去し、文字列内の生の改行・CR をエスケープして1回だけ修復を試みる。
 */
function repairJsonString(input: string): string {
  let out = '';
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escapeNext) {
      out += ch;
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        out += ch;
        escapeNext = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = true;
      continue;
    }
    if (ch === ',') {
      // 次に来る非空白文字が } または ] なら末尾カンマとしてスキップ
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === '}' || input[j] === ']') {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function unwrapCodeFence(text: string): string | null {
  const start = text.indexOf('```');
  if (start === -1) return null;
  const firstNewline = text.indexOf('\n', start + 3);
  if (firstNewline === -1) return null;
  const end = text.lastIndexOf('```');
  if (end <= firstNewline) return null;
  return text.slice(firstNewline + 1, end).trim();
}

/**
 * LLM の応答から JSON オブジェクトを頑健に抽出する。
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = stripThinkingTags(raw);
  if (!cleaned) return null;

  // 1. 直接パース
  const direct = tryParsePlainObject(cleaned);
  if (direct) return direct;

  // 2. コードフェンス除去
  const fenced = unwrapCodeFence(cleaned);
  if (fenced) {
    const fromFence = tryParsePlainObject(fenced);
    if (fromFence) return fromFence;
  }

  // 3. Balanced-brace スキャン（tool-call-parser.ts の文字列対応スキャナを再利用）
  const scanTarget = fenced ?? cleaned;
  for (let i = 0; i < scanTarget.length; i++) {
    if (scanTarget[i] !== '{') continue;
    const end = findMatchingBrace(scanTarget, i);
    if (end === -1) continue;
    const slice = scanTarget.slice(i, end + 1);
    const parsed =
      tryParsePlainObject(slice) ??
      tryParsePlainObject(repairJsonString(slice));
    if (parsed) return parsed;
  }

  // 4. 全体の修復リトライ
  return tryParsePlainObject(repairJsonString(scanTarget));
}

/** OpenAI互換APIの message.content を文字列へ正規化する。 */
export function extractOpenaiContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part == null || typeof part !== 'object') return '';
      const obj = part as Record<string, unknown>;
      if (typeof obj.text === 'string') return obj.text;
      if (typeof obj.content === 'string') return obj.content;
      return '';
    })
    .join('');
}

type GeminiStructuredResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
  }>;
};

type OpenaiStructuredResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

/**
 * Gemini / OpenAI 互換 API にツール無し・JSON 専用の構造化問い合わせを行う。
 * 例外は投げず、失敗・不正 JSON 時は null を返す。
 */
export async function callStructuredJson<T>(
  options: StructuredLlmCallOptions<T>
): Promise<T | null> {
  const log = options.log ?? (() => {});
  const provider = resolveProvider(options.provider);
  const temperature = options.temperature ?? 0.2;
  const usageGuard = getLlmUsageGuard(log);
  let budgetConsumed = false;

  try {
    const budget = await usageGuard.tryAcquire();
    if (!budget.allowed) {
      log(`構造化LLM呼び出しを抑制しました: ${budget.reason}`);
      return null;
    }
    budgetConsumed = true;
  } catch (err: unknown) {
    log(
      `LLM予算状態を更新できないため今回は継続します: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let rawText = '';

  try {
    if (provider === 'openai') {
      const rawOpenai = options.openaiConfig ?? config.aiProvider?.openai;
      const settings = resolveOpenaiSettings(rawOpenai);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (settings.apiKey) {
        headers.Authorization = `Bearer ${settings.apiKey}`;
      }

      const body: Record<string, unknown> = {
        model: settings.model,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
        temperature,
        max_tokens: options.maxTokens,
      };

      if (rawOpenai?.jsonMode === 'json_object') {
        body.response_format = { type: 'json_object' };
      }

      const res = await got
        .post(settings.apiUrl, {
          headers,
          json: body,
          responseType: 'json',
          timeout: { request: options.timeoutMs ?? settings.timeoutMs },
        })
        .json<OpenaiStructuredResponse>();

      rawText = extractOpenaiContentText(res.choices?.[0]?.message?.content);
    } else {
      const apiKey = options.geminiConfig?.apiKey ?? config.gemini?.apiKey;
      if (!apiKey) {
        log('構造化LLM呼び出し: Gemini APIキーが未設定です');
        return null;
      }
      const apiUrl = options.geminiConfig?.apiUrl ?? getGeminiApiUrl();

      const res = await got
        .post(apiUrl, {
          headers: { 'x-goog-api-key': apiKey },
          json: {
            systemInstruction: { parts: [{ text: options.system }] },
            contents: [{ role: 'user', parts: [{ text: options.user }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature,
              maxOutputTokens: options.maxTokens,
            },
          },
          responseType: 'json',
          timeout: { request: options.timeoutMs ?? 60_000 },
        })
        .json<GeminiStructuredResponse>();

      const candidate = res.candidates?.[0];
      if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
        log(`構造化LLM finishReason=${candidate.finishReason}`);
      }
      const parts = candidate?.content?.parts ?? [];
      rawText = parts
        .filter((p) => p.thought !== true && typeof p.text === 'string')
        .map((p) => p.text ?? '')
        .join('');
    }
    if (budgetConsumed) {
      await usageGuard.recordOutcome(true).catch(() => undefined);
    }
  } catch (err: unknown) {
    if (budgetConsumed) {
      await usageGuard.recordOutcome(false).catch(() => undefined);
    }
    log(
      `構造化LLM呼び出しエラー: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  const parsedObj = extractJsonObject(rawText);
  if (!parsedObj) {
    log('構造化LLM: JSONオブジェクトの抽出に失敗しました');
    return null;
  }

  try {
    return options.parse(parsedObj);
  } catch (err: unknown) {
    log(
      `構造化LLM検証エラー: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
