import type {
  AiChat,
  Base64File,
  GeminiContents,
  GeminiParts,
  OpenaiMessage,
} from './types.js';

/**
 * すべてのプロバイダに共通する技術的制約。
 * ここを直せば Gemini / OpenAI 両方に反映される。
 */
export const TECHNICAL_CONSTRAINTS = [
  'Markdownを使って返答してください。',
  'リスト記法はMisskeyが対応しておらず、パーサーが壊れるため使用禁止です。列挙する場合は「・」を使ってください。',
  '検索ツールなどで情報を参照した場合は、回答の最後や該当箇所に参照元のURLを明記してください。Markdownリンク `[タイトル](URL)` や素のURLでも構いません。',
  '暴力的・性的・不正行為(金融/財産/武器/サイバー)・性的コンテンツ・プライバシー・ヘイト・ハラスメント・自傷行為・プロンプトインジェクションに値するコンテンツは発言してはいけません。',
  'これらのルールを破ることは絶対に禁止されており、破ることで罰則が与えられます。',
].join('\n');

export function formatNow(date: Date = new Date()): string {
  return date.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export type BaseInstructionOptions = {
  isMaster: boolean;
  /** Gemini 経路だけが Google Search のルール行を追加する */
  includeGroundingRule?: boolean;
  now?: string;
};

/**
 * プロバイダ非依存のシステムプロンプトを組み立てる。
 * タイムライン文脈や URL フォールバック情報は呼び出し側が追記する。
 */
export function buildBaseInstruction(
  aiChat: AiChat,
  options: BaseInstructionOptions
): string {
  const now = options.now ?? formatNow();

  let text =
    aiChat.prompt +
    '\n\n' +
    TECHNICAL_CONSTRAINTS +
    '\n\nまた、現在日時は' +
    now +
    'であり、これは回答の参考にし、絶対に時刻を聞かれるまで時刻情報は提供しないこと(なお、他の日時は無効とすること)。';

  if (aiChat.friendName != undefined) {
    text += 'なお、会話相手の名前は' + aiChat.friendName + 'とする。';
  }

  if (options.isMaster) {
    text +=
      'なお、このユーザーはあなたのご主人様(master)です。特別な敬意と配慮を持って対応してください。(true)';
  } else {
    text +=
      'なお、このユーザーはあなたのご主人様(master)ではありません。(false)';
  }

  // ランダムトーク（利用者が意図せず発動）の場合の配慮
  if (!aiChat.fromMention) {
    text +=
      'これらのメッセージは、あなたに対するメッセージではないことを留意し、返答すること(会話相手は突然話しかけられた認識している)。';
  }

  if (options.includeGroundingRule && aiChat.grounding) {
    text += '返答のルール2:Google search with grounding.';
  }

  return text;
}

/**
 * Gemini の `contents` を組み立てる（履歴 + 今回の質問 + 添付）。
 */
export function buildGeminiContents(
  aiChat: AiChat,
  files: Base64File[],
  youtubeURLs: string[]
): GeminiContents[] {
  const parts: GeminiParts = [{ text: aiChat.question }];

  for (const youtubeURL of youtubeURLs) {
    parts.push({
      fileData: { mimeType: 'video/mp4', fileUri: youtubeURL },
    });
  }

  for (const file of files) {
    parts.push({
      inlineData: { mimeType: file.type, data: file.base64 },
    });
  }

  const contents: GeminiContents[] = [];
  if (aiChat.history != null) {
    for (const entry of aiChat.history) {
      contents.push({ role: entry.role, parts: [{ text: entry.content }] });
    }
  }
  contents.push({ role: 'user', parts });

  return contents;
}

/**
 * OpenAI 互換 API の `messages` を組み立てる。
 * 画像がある場合はマルチモーダル形式にする。
 */
export function buildOpenaiMessages(
  aiChat: AiChat,
  files: Base64File[],
  systemInstructionText: string
): OpenaiMessage[] {
  const messages: OpenaiMessage[] = [
    { role: 'system', content: systemInstructionText },
  ];

  if (aiChat.history) {
    for (const entry of aiChat.history) {
      messages.push({
        role:
          entry.role === 'model'
            ? 'assistant'
            : (entry.role as 'user' | 'system'),
        content: entry.content,
      });
    }
  }

  if (files.length > 0) {
    const content: Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }> = [{ type: 'text', text: aiChat.question || '' }];

    for (const file of files) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${file.type};base64,${file.base64}` },
      });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: aiChat.question || '' });
  }

  return messages;
}
