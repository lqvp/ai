import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import { fetchNoteFiles } from '@/services/media.js';
import { uploadGeneratedFile } from '@/services/upload.js';
import {
  extractImage,
  generateImage,
  generateImageWithGemini,
  type ImagenApiResponse,
} from './api.js';

export default class extends Module {
  public readonly name = 'imagen';

  private get apiKey(): string | undefined {
    return config.imagen?.apiKey || config.gemini?.apiKey;
  }

  @bindThis
  public install() {
    // Imagen機能が有効かチェック
    if (!config.imagen?.enabled || !this.apiKey) {
      this.log('Imagen機能が無効、またはAPIキーが設定されていません');
      return false;
    }

    return {
      mentionHook: this.mentionHook,
    };
  }

  @bindThis
  private isFollowing(userId: string): Promise<boolean> {
    return this.ai.relationship.isFollowing(userId);
  }

  private get apiOptions() {
    return {
      apiKey: this.apiKey,
      log: (message: string) => this.log(message),
      model: config.imagen?.model,
    };
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (!msg.includes(['imagen'])) {
      return false;
    }

    // Imagen機能が有効かチェック
    if (!config.imagen?.enabled || !this.apiKey) {
      msg.reply(serifs.aichat.nothing('imagen'));
      return false;
    }

    // フォローチェック
    const isFollowing = await this.isFollowing(msg.userId);
    if (!isFollowing) {
      this.log(`User ${msg.userId} is not following, ignoring imagen request`);
      return false;
    }

    // プロンプトを抽出
    const text = msg.extractedText;
    const match = text.match(/imagen\s+(.+)/i);
    if (!match?.[1]) {
      msg.reply(
        '画像生成のプロンプトを指定してください。\n例: @藍 imagen a cute cat\n\n画像付きの投稿や引用RNの画像を基にした画像生成も可能です。'
      );
      return false;
    }

    const prompt = match[1].trim();
    if (prompt.length === 0) {
      msg.reply('画像生成のプロンプトを指定してください。');
      return false;
    }

    this.log(`Starting image generation for: ${prompt}`);

    // 生成中リアクションを追加
    void this.ai.reactions.reactForce(msg.id, '🎨');

    try {
      const files = await fetchNoteFiles(this.ai.api, msg.id, {
        normalizeImageType: true,
        log: (m) => this.log(m),
      });

      let quotedFiles: typeof files = [];
      if (msg.quoteId) {
        quotedFiles = await fetchNoteFiles(this.ai.api, msg.quoteId, {
          normalizeImageType: true,
          log: (m) => this.log(m),
        });
        this.log(`Found ${quotedFiles.length} quoted files`);
      }

      const allFiles = [...files, ...quotedFiles];
      this.log(
        `Total files to process: ${allFiles.length} (current: ${files.length}, quoted: ${quotedFiles.length})`
      );

      // 画像がある場合は Gemini API、ない場合は従来の Imagen API を使う
      let response: ImagenApiResponse;
      if (allFiles.length > 0) {
        this.log(`Using Gemini API with ${allFiles.length} images`);
        response = await generateImageWithGemini(
          prompt,
          allFiles,
          this.apiOptions
        );
      } else {
        this.log('Using traditional Imagen API');
        response = await generateImage(prompt, this.apiOptions);
      }

      if (response == null || response.error) {
        const errorMsg = response?.error?.message || '不明なエラー';
        this.log(`Image generation failed: ${errorMsg}`);
        msg.reply(`画像生成でエラーが発生しました: ${errorMsg}`);
        return { reaction: '❌️' };
      }

      if ('candidates' in response && response.candidates?.length === 0) {
        this.log('No image generated from Gemini API');
        msg.reply('画像が生成されませんでした。プロンプトを見直してください。');
        return { reaction: '❌️' };
      }
      if ('predictions' in response && response.predictions?.length === 0) {
        this.log('No image generated from Imagen API');
        msg.reply('画像が生成されませんでした。プロンプトを見直してください。');
        return { reaction: '❌️' };
      }

      const image = extractImage(response);
      if (!image) {
        this.log('No image data in the API response');
        msg.reply('画像データが取得できませんでした。');
        return { reaction: '❌️' };
      }

      const fileId = await uploadGeneratedFile(
        this.ai,
        Buffer.from(image.base64, 'base64'),
        {
          mimeType: image.mimeType,
          prefix: 'imagen',
          fallbackExtension: 'png',
        },
        (m) => this.log(m)
      );

      if (!fileId) {
        msg.reply('画像のアップロードに失敗しました。');
        return { reaction: '❌️' };
      }

      msg.reply(`「${prompt}」で画像を生成しました！`, {
        file: { id: fileId },
      });

      this.log(`Image generation completed for: ${prompt}`);
      return { reaction: 'like' };
    } catch (error) {
      this.log(`Unexpected error during image generation: ${error}`);
      msg.reply('画像生成中に予期しないエラーが発生しました。');
      return { reaction: '❌️' };
    }
  }
}
