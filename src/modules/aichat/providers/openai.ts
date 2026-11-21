import got from 'got';
import config from '@/config/index.js';
import type Message from '@/message.js';
import {
  type OpenaiSettings,
  resolveOpenaiSettings,
} from '../openai-settings.js';
import {
  buildBaseInstruction,
  buildOpenaiMessages,
} from '../prompt-builder.js';
import { REACTION_MARKER_INSTRUCTION } from '../reaction-marker.js';
import { parseToolCallsFromContent } from '../tool-call-parser.js';
import { buildOpenaiTools, executeToolCall } from '../tools.js';
import type {
  AiChat,
  Base64File,
  GeminiApiResponse,
  OpenaiAssistantMessage,
  OpenaiMessage,
  OpenaiOptions,
  OpenaiToolCall,
} from '../types.js';
import type { ProviderContext } from './types.js';

/** OpenAI互換API (chat/completions) のレスポンス。利用フィールドのみ定義。 */
type OpenaiChatCompletion = {
  choices?: {
    message?: {
      content?: unknown;
      tool_calls?: OpenaiToolCall[];
    };
  }[];
};

/** 設定から解決した共通ヘッダとタイムアウトで chat/completions を呼ぶ。 */
async function postChatCompletion(
  settings: OpenaiSettings,
  body: OpenaiOptions
): Promise<OpenaiChatCompletion> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  // キー不要のエンドポイント（vLLM など）では Authorization を送らない
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  return got
    .post(settings.apiUrl, {
      headers,
      json: body,
      responseType: 'json',
      timeout: { request: settings.timeoutMs },
    })
    .json<OpenaiChatCompletion>();
}

/** got のエラーから HTTP ステータスとメッセージを取り出す。 */
function toHttpError(err: unknown): {
  errorCode: number | null;
  errorMessage: string | null;
} {
  if (err && typeof err === 'object' && 'response' in err) {
    const httpError = err as {
      response?: { statusCode?: number; statusMessage?: string };
      message?: string;
    };
    if (typeof httpError.response?.statusCode === 'number') {
      return {
        errorCode: httpError.response.statusCode,
        errorMessage:
          httpError.response?.statusMessage || httpError.message || null,
      };
    }
  }
  return { errorCode: null, errorMessage: null };
}

export async function genTextByOpenai(
  aiChat: AiChat,
  files: Base64File[],
  msg: Message | undefined,
  ctx: ProviderContext
): Promise<GeminiApiResponse> {
  ctx.log('Generate Text By OpenAI Compatible API...');

  const settings = resolveOpenaiSettings();

  let systemInstructionText = buildBaseInstruction(aiChat, {
    isMaster: msg != null && ctx.isMasterUser(msg),
  });

  // URL 情報の収集は Gemini 経路と共通
  const { fallbackUrlInfo } = await ctx.collectUrlInfo(aiChat);
  if (fallbackUrlInfo) {
    systemInstructionText +=
      '\n\n【フォールバックURL情報】\n' + fallbackUrlInfo;
  }

  // ユーザー投稿履歴文脈情報を追加
  systemInstructionText += ctx.formatTimelineContext(aiChat.timelineContext);

  // エピソード記憶の回想コンテキスト（会話相手に関する長期記憶）
  systemInstructionText += aiChat.memoryRecallContext ?? '';

  // 気分コンテキストとパーソナライズドリアクション指示（メイン生成に同居）
  systemInstructionText += aiChat.moodContext ?? '';
  systemInstructionText += aiChat.reactionMarkerEnabled
    ? REACTION_MARKER_INSTRUCTION
    : '';

  const messages: OpenaiMessage[] = buildOpenaiMessages(
    aiChat,
    files,
    systemInstructionText
  );

  // Exa / Jina / Misskey ツールの構築
  const exaConfig = config.exa;
  const jinaConfig = config.jina;
  const misskeyTools = ctx.getMisskeyTools?.() ?? null;
  const toolRuntime = buildOpenaiTools(exaConfig, jinaConfig, misskeyTools);

  if (exaConfig?.enabled || jinaConfig?.enabled) {
    ctx.log(
      `OpenAI互換プロバイダーツール設定: exa_search=${toolRuntime.tools.some((t) => t.function.name === 'exa_search')}, jina_read=${toolRuntime.tools.some((t) => t.function.name === 'jina_read')}`
    );
  }

  const maxRounds = toolRuntime.maxRounds;

  /** 生成パラメータ（temperature / max_tokens は設定があれば付与する）。 */
  const baseOptions: OpenaiOptions = {
    model: settings.model,
    messages,
    ...(settings.temperature !== undefined
      ? { temperature: settings.temperature }
      : {}),
    ...(settings.maxTokens !== undefined
      ? { max_tokens: settings.maxTokens }
      : {}),
  };

  let responseText = '';

  /**
   * ツール呼び出しを禁止して最終アシスタント本文を取得する。
   * 空で返ってきた場合は文章での応答を明示して1回だけ再試行する。
   */
  const requestFinalText = async (): Promise<string> => {
    const fetchText = async (extraUserMessage?: string): Promise<string> => {
      // 共有している messages は汚さない（再試行時のみ末尾に指示を足す）
      const finalMessages = extraUserMessage
        ? ([
            ...messages,
            { role: 'user', content: extraUserMessage },
          ] as OpenaiMessage[])
        : messages;
      const res = await postChatCompletion(settings, {
        ...baseOptions,
        messages: finalMessages,
        ...(toolRuntime.hasAnyTool
          ? {
              tools: toolRuntime.tools,
              tool_choice: 'none' as const,
            }
          : {}),
      });
      const finalMessage = res.choices?.[0]?.message;
      return typeof finalMessage?.content === 'string'
        ? finalMessage.content
        : '';
    };

    try {
      let text = await fetchText();
      if (text === '') {
        ctx.log('最終応答が空のため、文章での応答を明示して再試行します');
        text = await fetchText(
          '（システム通知: このリクエストではツール呼び出しを使用できません。必ず通常の文章で応答してください。）'
        );
      }
      return text;
    } catch (err: unknown) {
      if (err instanceof Error) {
        ctx.log(`最終応答取得エラー: ${err.name} ${err.message}`);
      }
      return '';
    }
  };

  for (let round = 0; round < maxRounds; round++) {
    const isLastRound = round === maxRounds - 1;

    const openaiOptions: OpenaiOptions = {
      ...baseOptions,
      messages,
    };
    if (toolRuntime.hasAnyTool) {
      openaiOptions.tools = toolRuntime.tools;
      openaiOptions.tool_choice = 'auto';
    }

    let resData: OpenaiChatCompletion;
    try {
      resData = await postChatCompletion(settings, openaiOptions);

      ctx.log(
        `OpenAI互換APIレスポンス(round=${round}): ${JSON.stringify(resData).slice(0, 1000)}`
      );
    } catch (err: unknown) {
      ctx.log('Error By Call OpenAI Compatible API');
      if (err instanceof Error) {
        ctx.log(`${err.name}\n${err.message}\n${err.stack}`);
      }

      const { errorCode, errorMessage } = toHttpError(err);
      return { error: true, errorCode, errorMessage };
    }

    const choice = resData?.choices?.[0];
    const assistantMessage = choice?.message;
    if (!assistantMessage) {
      ctx.log('OpenAI互換API: choices[0].message が空です');
      return { error: true, errorCode: null, errorMessage: 'empty response' };
    }

    const structuredToolCalls: OpenaiToolCall[] | undefined = Array.isArray(
      assistantMessage.tool_calls
    )
      ? assistantMessage.tool_calls
      : undefined;

    let contentText: string =
      typeof assistantMessage.content === 'string'
        ? assistantMessage.content
        : '';

    let effectiveToolCalls: OpenaiToolCall[] = structuredToolCalls ?? [];
    if (effectiveToolCalls.length === 0) {
      const parsed = parseToolCallsFromContent(contentText, {
        warn: (msg) => ctx.log(msg),
      });
      if (parsed.toolCalls.length > 0) {
        effectiveToolCalls = parsed.toolCalls as OpenaiToolCall[];
        contentText = parsed.cleanedContent;
        ctx.log(
          `content内のtool call markupを検出: ${effectiveToolCalls
            .map((c) => `${c.function.name}(${c.function.arguments})`)
            .join(', ')}`
        );
      }
    }

    const assistantEntry: OpenaiAssistantMessage = {
      role: 'assistant',
      content: contentText,
      ...(effectiveToolCalls.length > 0
        ? { tool_calls: effectiveToolCalls }
        : {}),
    };
    messages.push(assistantEntry);

    if (effectiveToolCalls.length === 0) {
      if (contentText !== '') {
        responseText = contentText;
        break;
      }
      // 本文が空のまま終了しそうな場合は、ツール禁止で最終応答を取得する
      ctx.log('応答本文が空のため、ツール呼び出しを禁止して再取得します');
      responseText = await requestFinalText();
      break;
    }

    // ツール呼び出しを実行
    ctx.log(
      `ツール呼び出し(round=${round}): ${effectiveToolCalls
        .map((c) => `${c.function.name}(${c.function.arguments})`)
        .join(', ')}`
    );

    const results = await Promise.all(
      effectiveToolCalls.map(async (call) => {
        const toolResult = await executeToolCall(
          call,
          exaConfig,
          jinaConfig,
          misskeyTools
        );
        ctx.log(
          `ツール結果(${call.function.name}, id=${call.id}): ${toolResult.slice(0, 200)}`
        );
        return { call, content: toolResult };
      })
    );

    for (const { call, content } of results) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content,
      });
    }

    // 最終ラウンドの場合はツール結果を反映した上で本文を強制
    if (isLastRound) {
      ctx.log('最終ラウンドに到達したため、ツールなしで最終応答を取得します');
      responseText = await requestFinalText();
      break;
    }
  }

  return responseText;
}
