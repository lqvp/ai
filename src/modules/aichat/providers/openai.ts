import got from 'got';
import config from '@/config.js';
import type Message from '@/message.js';
import { EXA_TOOL_SEARCH, JINA_TOOL_READ } from '../constants.js';
import {
  buildBaseInstruction,
  buildOpenaiMessages,
} from '../prompt-builder.js';
import { parseToolCallsFromContent } from '../tool-call-parser.js';
import { executeToolCall } from '../tools.js';
import type {
  AiChat,
  Base64File,
  GeminiApiResponse,
  OpenaiAssistantMessage,
  OpenaiFunctionTool,
  OpenaiMessage,
  OpenaiOptions,
  OpenaiToolCall,
} from '../types.js';
import type { ProviderContext } from './types.js';

export async function genTextByOpenai(
  aiChat: AiChat,
  files: Base64File[],
  msg: Message | undefined,
  ctx: ProviderContext
): Promise<GeminiApiResponse> {
  ctx.log('Generate Text By OpenAI Compatible API...');

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

  const messages: OpenaiMessage[] = buildOpenaiMessages(
    aiChat,
    files,
    systemInstructionText
  );

  // OpenAI APIリクエストを構築
  const model = config.aiProvider?.openai?.model || 'gpt-4o-mini';
  const baseUrl =
    config.aiProvider?.openai?.baseUrl || 'https://api.openai.com';
  const apiUrl = `${baseUrl}/v1/chat/completions`;
  const apiKey = config.aiProvider?.openai?.apiKey;

  if (!apiKey) {
    ctx.log('OpenAI API key is not configured');
    return {
      error: true,
      errorCode: null,
      errorMessage: 'OpenAI API key is not configured',
    };
  }

  // Exa / Jina ツールの構築
  const exaConfig = config.exa;
  const exaEnabled = exaConfig?.enabled === true;
  const exaApiKey = exaConfig?.apiKey;
  const exaSearchEnabled = exaConfig?.search?.enabled !== false;
  const jinaConfig = config.jina;
  const jinaEnabled = jinaConfig?.enabled === true;
  const readEnabled = jinaConfig?.read?.enabled !== false;
  const includeExaSearchTool = exaEnabled && exaSearchEnabled && !!exaApiKey;
  const includeReadTool = jinaEnabled && readEnabled;
  const includeAnyTool = includeExaSearchTool || includeReadTool;

  if (exaEnabled || jinaEnabled) {
    ctx.log(
      `OpenAI互換プロバイダーツール設定: exa_search=${includeExaSearchTool}, jina_read=${includeReadTool}`
    );
  }

  const tools: OpenaiFunctionTool[] = [];
  if (includeExaSearchTool) {
    tools.push({
      type: 'function',
      function: {
        name: EXA_TOOL_SEARCH,
        description:
          'Exa でWeb検索を行い、上位の結果（タイトル/URL/ハイライト本文）を取得します。最新の話題や外部情報を参照したいときに使ってください。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '検索クエリ（自然文）',
            },
          },
          required: ['query'],
        },
      },
    });
  }
  if (includeReadTool) {
    tools.push({
      type: 'function',
      function: {
        name: JINA_TOOL_READ,
        description:
          '指定したURLの本文をJina AI Readerで抽出します。記事やドキュメント本文を読みたいときに使ってください。',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: '読み取り対象のhttp/https URL',
            },
          },
          required: ['url'],
        },
      },
    });
  }

  const maxRoundsRaw =
    exaConfig?.tool?.maxRounds ?? jinaConfig?.tool?.maxRounds;
  const parsedMaxRounds =
    typeof maxRoundsRaw === 'number' && !Number.isNaN(maxRoundsRaw)
      ? Math.floor(maxRoundsRaw)
      : 3;
  const maxRounds = Math.max(1, parsedMaxRounds);

  let responseText = '';

  for (let round = 0; round < maxRounds; round++) {
    const isLastRound = round === maxRounds - 1;
    const sendTools = includeAnyTool && !isLastRound;

    const openaiOptions: OpenaiOptions = {
      model,
      messages,
    };
    if (sendTools) {
      openaiOptions.tools = tools;
      openaiOptions.tool_choice = 'auto';
    }

    let resData: any = null;
    try {
      resData = await got
        .post(apiUrl, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          json: openaiOptions,
          responseType: 'json',
        })
        .json();

      ctx.log(
        `OpenAI互換APIレスポンス(round=${round}): ${JSON.stringify(resData)}`
      );
    } catch (err: unknown) {
      ctx.log('Error By Call OpenAI Compatible API');
      let errorCode: number | null = null;
      let errorMessage: string | null = null;

      if (err && typeof err === 'object' && 'response' in err) {
        const httpError = err as {
          response?: { statusCode?: number; statusMessage?: string };
          message?: string;
        };
        if (typeof httpError.response?.statusCode === 'number') {
          errorCode = httpError.response.statusCode;
        }
        errorMessage =
          httpError.response?.statusMessage || httpError.message || null;
      }

      if (err instanceof Error) {
        ctx.log(`${err.name}\n${err.message}\n${err.stack}`);
      }

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
      ? (assistantMessage.tool_calls as OpenaiToolCall[])
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
      responseText = contentText;
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
        const toolResult = await executeToolCall(call, exaConfig, jinaConfig);
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

    // 最終ラウンドの場合はツールを送らず、最終アシスタント本文を強制
    if (isLastRound) {
      ctx.log('最終ラウンドに到達したため、ツールなしで最終応答を取得します');
      try {
        const finalRes: any = await got
          .post(apiUrl, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            json: { model, messages },
            responseType: 'json',
          })
          .json();
        const finalContent =
          typeof finalRes?.choices?.[0]?.message?.content === 'string'
            ? finalRes.choices[0].message.content
            : '';
        responseText = finalContent;
      } catch (err: unknown) {
        if (err instanceof Error) {
          ctx.log(`最終ラウンド取得エラー: ${err.name} ${err.message}`);
        }
        responseText = contentText;
      }
      break;
    }
  }

  return responseText;
}
