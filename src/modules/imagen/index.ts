import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import Message from '@/message.js';
import Ai, { HandlerResult, InstallerResult } from '@/ai.js';
import config from '@/config.js';
import got, { HTTPError } from 'got';
import { Buffer } from 'buffer';

export default class ImagenModule extends Module {
    public readonly name = 'imagen';

  public init(ai: Ai) {
    this.ai = ai;
  }

  @bindThis
    public install(): InstallerResult {
    if (!config.imagenEnabled || !config.imagenApiKey) {
      return {};
    }

    return {
      mentionHook: this.mentionHook,
    };
  }

  @bindThis
    private async mentionHook(msg: Message): Promise<boolean | HandlerResult> {
    const match = msg.text.match(/(?:imagen|画像生成)\s+(.+)/i);
    if (!match) {
      return false;
    }

    const prompt = match[1].trim();
    if (prompt.length === 0) {
      msg.reply('プロンプト（画像にしてほしい言葉）を指定してください。');
      return true;
    }

    // ユーザーに処理開始を通知
    await msg.reply('画像を生成しています、少し待ってね…🎨');
    // 元の投稿にリアクションをつける
    await this.ai.api('notes/reactions/create', {
      noteId: msg.id,
      reaction: '🎨',
    });

    try {
      const predictions = await this.generateImage(prompt);

      if (!predictions || predictions.length === 0) {
        throw new Error('APIから画像が返されませんでした。');
      }

      const imageBuffer = Buffer.from(predictions[0].bytesBase64Encoded, 'base64');

            const file = (await this.ai.upload(imageBuffer, {
        filename: `${prompt.slice(0, 20).replace(/\s/g, '_')}.png`,
        contentType: predictions[0].mimeType,
      })) as { id: string };

      await this.ai.post({
        replyId: msg.id,
        text: '出来ました！',
        fileIds: [file.id],
      });

      // リアクションを完了済みに更新
      await this.ai.api('notes/reactions/create', {
        noteId: msg.id,
        reaction: '✅',
      });

      return true;
    } catch (error) {
      console.error(error);
      let replyText = 'ごめんなさい、画像の生成に失敗しました…😢';
      if (error instanceof HTTPError) {
        try {
          const errorBody = JSON.parse(error.response.body as string);
          replyText += '\n\nエラー詳細:\n```json\n' + JSON.stringify(errorBody, null, 2) + '\n```';
        } catch {
          replyText += '\n\nエラー詳細:\n```\n' + error.response.body + '\n```';
        }
      }
      msg.reply(replyText);
      return true;
    }
  }

  @bindThis
  private async generateImage(prompt: string): Promise<{ bytesBase64Encoded: string; mimeType: string }[]> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-preview-06-06:predict?key=${config.imagenApiKey}`;

    const response = await got.post(endpoint, {
      json: {
        instances: [{ prompt: prompt }],
        parameters: { sampleCount: 1 },
      },
      timeout: { request: 120000 }, // タイムアウトを2分に設定
    }).json<{ predictions: { bytesBase64Encoded: string; mimeType: string }[] }>();

    return response.predictions;
  }
}
