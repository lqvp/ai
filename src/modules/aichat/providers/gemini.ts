import got from 'got';
import config from '@/config.js';
import type Message from '@/message.js';
import {
  buildBaseInstruction,
  buildGeminiContents,
} from '../prompt-builder.js';
import type {
  AiChat,
  Base64File,
  GeminiApiResponse,
  GeminiContents,
  GeminiOptions,
  GeminiSystemInstruction,
} from '../types.js';
import type { ProviderContext } from './types.js';

export type { ProviderContext } from './types.js';

/** Gemini API のレスポンス。利用しているフィールドのみ定義する。 */
type GeminiUrlMetadataEntry = {
  retrieved_url?: string;
  url_retrieval_status?: string;
};

type GeminiCandidate = {
  content?: { parts?: { text?: string }[] };
  groundingMetadata?: {
    groundingChunks?: { web?: { uri?: string; title?: string } }[];
    webSearchQueries?: string[];
  };
  url_context_metadata?: { url_metadata?: GeminiUrlMetadataEntry[] };
};

type GeminiApiJson = {
  candidates?: GeminiCandidate[];
};

export async function genTextByGemini(
  aiChat: AiChat,
  files: Base64File[],
  msg: Message | undefined,
  ctx: ProviderContext
): Promise<GeminiApiResponse> {
  ctx.log('Generate Text By Gemini...');

  let systemInstructionText = buildBaseInstruction(aiChat, {
    isMaster: msg != null && ctx.isMasterUser(msg),
    includeGroundingRule: true,
  });

  // ユーザー投稿履歴文脈情報を追加
  systemInstructionText += ctx.formatTimelineContext(aiChat.timelineContext);

  // URL 情報の収集（YouTube とフォールバック用プレビュー）は OpenAI 経路と共通
  const urlInfo = await ctx.collectUrlInfo(aiChat);
  const { youtubeURLs, hasYoutubeUrl } = urlInfo;
  let fallbackUrlInfo = urlInfo.fallbackUrlInfo;

  // フォールバック用のURL情報を追加（後でURLコンテキストツールの使用状況に応じて制御）
  if (fallbackUrlInfo) {
    systemInstructionText +=
      '\n\n【フォールバックURL情報】\n' + fallbackUrlInfo;
  }

  const systemInstruction: GeminiSystemInstruction = {
    role: 'system',
    parts: [{ text: systemInstructionText }],
  };

  const contents: GeminiContents[] = buildGeminiContents(
    aiChat,
    files,
    youtubeURLs
  );

  let geminiOptions: GeminiOptions = {
    contents: contents,
    systemInstruction: systemInstruction,
  };

  // URLコンテキストツールが使用される場合、質問文を調整
  if (geminiOptions.tools?.some((tool) => tool.url_context)) {
    // URLコンテキストツールが使用される場合、質問文にURLを明示的に含める
    const urlexp = RegExp("(https?://[a-zA-Z0-9!?/+_~=:;.,*&@#$%'-]+)", 'g');
    const urlarray = [...aiChat.question.matchAll(urlexp)];
    if (urlarray.length > 0) {
      const nonYoutubeUrls = urlarray.filter(
        (url) => !ctx.isYoutubeUrl(url[0])
      );
      if (nonYoutubeUrls.length > 0) {
        // 最初のユーザーメッセージの質問文を更新
        if (contents.length > 0) {
          const lastContent = contents[contents.length - 1];
          if (lastContent.role === 'user' && lastContent.parts.length > 0) {
            const questionText = `${
              aiChat.question
            }\n\n参考URL:\n${nonYoutubeUrls.map((url) => url[0]).join('\n')}`;
            lastContent.parts[0].text = questionText;
            ctx.log('URLコンテキスト用に質問文を調整しました');
          }
        }
      }
    }
  }

  // thinkingConfigの設定
  if (config.gemini?.thinkingBudget !== undefined) {
    geminiOptions.generationConfig = {
      thinkingConfig: {
        thinkingBudget: config.gemini.thinkingBudget,
      },
    };
  }

  // ツールの設定
  if (geminiOptions.tools === undefined) {
    geminiOptions.tools = [];
  }

  // URLがある場合はURLコンテキストを追加
  if (aiChat.question !== undefined && aiChat.question.length > 0) {
    const urlexp = RegExp("(https?://[a-zA-Z0-9!?/+_~=:;.,*&@#$%'-]+)", 'g');
    const urlarray = [...aiChat.question.matchAll(urlexp)];

    if (urlarray.length > 0) {
      // YouTube以外のURLがある場合はURLコンテキストツールを追加
      const hasNonYoutubeUrl = urlarray.some(
        (url) => !ctx.isYoutubeUrl(url[0])
      );
      if (hasNonYoutubeUrl) {
        geminiOptions.tools.push({ url_context: {} });
        ctx.log('URLコンテキストツールを有効化しました');

        // URLコンテキストツールが使用される場合、フォールバック情報をsystemInstructionTextから削除
        if (fallbackUrlInfo) {
          systemInstructionText = systemInstructionText.replace(
            '\n\n【フォールバックURL情報】\n' + fallbackUrlInfo,
            ''
          );
          ctx.log(
            'フォールバックURL情報をsystemInstructionTextから削除しました'
          );
        }

        // URLコンテキストツールが使用される場合、フォールバック情報をクリア
        fallbackUrlInfo = '';
      }
    }
  }

  // YouTubeURLがある場合はグラウンディングを無効化
  if (aiChat.grounding && !hasYoutubeUrl) {
    geminiOptions.tools.push({ google_search: {} });
    ctx.log('Google Searchツールを有効化しました');
  }

  // ツールが設定されているかログ出力
  if (geminiOptions.tools.length > 0) {
    ctx.log(`使用するツール: ${JSON.stringify(geminiOptions.tools)}`);
  }

  let options = {
    url: aiChat.api,
    searchParams: {
      key: aiChat.key,
    },
    json: geminiOptions,
  };
  // ctx.log(JSON.stringify(options));
  let res_data: GeminiApiJson;
  let responseText: string = '';
  try {
    res_data = await got
      .post(options.url, {
        searchParams: options.searchParams,
        json: options.json,
        responseType: 'json',
      })
      .json<GeminiApiJson>();
    ctx.log(JSON.stringify(res_data));
    if (res_data.hasOwnProperty('candidates')) {
      // hasOwnProperty 通過後も candidates が空配列の可能性があるため、
      // 各ブロックの既存ガード（length チェック / hasOwnProperty）で保護される
      const candidate = res_data.candidates![0];
      if ((res_data.candidates?.length ?? 0) > 0) {
        // 結果を取得
        if (candidate.hasOwnProperty('content')) {
          if (candidate.content?.hasOwnProperty('parts')) {
            for (let i = 0; i < candidate.content!.parts!.length; i++) {
              if (candidate.content!.parts![i].hasOwnProperty('text')) {
                responseText += String(candidate.content!.parts![i].text);
              }
            }
          }
        }
      }
      // groundingMetadataを取得
      let groundingMetadata = '';
      if (candidate.hasOwnProperty('groundingMetadata')) {
        // 参考サイト情報
        if (candidate.groundingMetadata?.hasOwnProperty('groundingChunks')) {
          // 参考サイトが多すぎる場合があるので、3つに制限
          let checkMaxLength =
            candidate.groundingMetadata!.groundingChunks!.length;
          if (candidate.groundingMetadata!.groundingChunks!.length > 3) {
            checkMaxLength = 3;
          }
          for (let i = 0; i < checkMaxLength; i++) {
            const chunk = candidate.groundingMetadata!.groundingChunks![i];
            if (chunk.hasOwnProperty('web')) {
              const web = chunk.web!;
              if (web.hasOwnProperty('uri') && web.hasOwnProperty('title')) {
                groundingMetadata += `参考(${i + 1}): [${web.title}](${web.uri})\n`;
              }
            }
          }
        }
        // 検索ワード
        if (candidate.groundingMetadata?.hasOwnProperty('webSearchQueries')) {
          if (
            (candidate.groundingMetadata!.webSearchQueries?.length ?? 0) > 0
          ) {
            groundingMetadata +=
              '検索ワード: ' +
              candidate.groundingMetadata!.webSearchQueries!.join(',') +
              '\n';
          }
        }
      }
      responseText += groundingMetadata;

      // URLコンテキストの結果を処理
      let urlContextMetadata = '';
      let hasSuccessfulUrlContext = false;

      // URLコンテキストツールが使用されている場合の処理
      if (geminiOptions.tools?.some((tool) => tool.url_context)) {
        if (candidate.hasOwnProperty('url_context_metadata')) {
          if (candidate.url_context_metadata?.hasOwnProperty('url_metadata')) {
            const urlMetadata = candidate.url_context_metadata!.url_metadata;
            if (urlMetadata && urlMetadata.length > 0) {
              // URLコンテキストが成功している場合は、フォールバック情報は不要
              const successfulUrls = urlMetadata.filter(
                (metadata) =>
                  metadata.url_retrieval_status ===
                  'URL_RETRIEVAL_STATUS_SUCCESS'
              );

              if (successfulUrls.length > 0) {
                hasSuccessfulUrlContext = true;
                // URLコンテキストが成功している場合は、フォールバック情報をクリア
                fallbackUrlInfo = '';

                // 成功したURLの情報を表示
                urlContextMetadata += '\n【参考URL】\n';
                successfulUrls.forEach((metadata, index: number) => {
                  urlContextMetadata += `参考URL(${index + 1}): ${
                    metadata.retrieved_url
                  }\n`;
                });
              }
            }
          }
        }
      }

      responseText += urlContextMetadata;

      // URLコンテキストが失敗した場合のみフォールバック情報を追加
      if (!hasSuccessfulUrlContext && fallbackUrlInfo) {
        responseText +=
          '\n【フォールバックURL情報（URLコンテキストが失敗したため）】\n' +
          fallbackUrlInfo;
      }
    }
  } catch (err: unknown) {
    ctx.log('Error By Call Gemini');
    let errorCode: number | null = null;
    let errorMessage: string | null = null;

    // HTTPErrorからエラーコードと内容を取得
    if (err && typeof err === 'object' && 'response' in err) {
      const httpError = err as {
        response?: { statusCode?: number; statusMessage?: string };
        message?: string;
      };
      errorCode = httpError.response?.statusCode ?? null;
      errorMessage =
        httpError.response?.statusMessage || httpError.message || null;
    }

    if (err instanceof Error) {
      ctx.log(`${err.name}\n${err.message}\n${err.stack}`);
    }

    // エラー情報を返す
    return { error: true, errorCode, errorMessage };
  }
  return responseText;
}
