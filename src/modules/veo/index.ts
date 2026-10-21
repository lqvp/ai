import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import { uploadGeneratedFile } from '@/services/upload.js';
import {
  downloadVideo,
  generateVideo,
  type VeoClientOptions,
} from './client.js';

export default class extends Module {
  public readonly name = 'veo';

  private get apiKey(): string | undefined {
    return config.veo?.apiKey || config.gemini?.apiKey;
  }

  @bindThis
  public install() {
    if (!config.veo?.enabled || !this.apiKey) {
      this.log('Veo機能が無効、またはAPIキーが設定されていません');
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

  private get clientOptions(): VeoClientOptions {
    return {
      apiKey: this.apiKey,
      log: (message: string) => this.log(message),
      model: config.veo?.model,
      pollIntervalMs: config.veo?.pollIntervalMs,
      maxWaitMs: config.veo?.maxWaitMs,
    };
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (!msg.includes(['veo'])) {
      return false;
    }

    if (!config.veo?.enabled || !this.apiKey) {
      msg.reply(serifs.aichat.nothing('veo'));
      return false;
    }

    const isFollowing = await this.isFollowing(msg.userId);
    if (!isFollowing) {
      this.log(`User ${msg.userId} is not following, ignoring veo request`);
      return false;
    }

    const text = msg.extractedText;
    const match = text.match(/veo\s+(.+)/i);
    if (!match || !match[1]) {
      msg.reply(
        '動画生成のプロンプトを指定してください。\n例: @藍 veo a beautiful landscape'
      );
      return false;
    }

    const prompt = match[1].trim();
    if (prompt.length === 0) {
      msg.reply('動画生成のプロンプトを指定してください。');
      return false;
    }

    this.log(`Starting video generation for: ${prompt}`);

    void this.ai.reactions.reactForce(msg.id, '🎬');

    try {
      const result = await generateVideo(prompt, this.clientOptions);

      if (typeof result !== 'string') {
        this.log(`Video generation failed: ${result.error}`);
        msg.reply(`動画生成でエラーが発生しました: ${result.error}`);
        return { reaction: '❌️' };
      }

      const videoBuffer = await downloadVideo(result, this.apiKey, (m) =>
        this.log(m)
      );
      if (!videoBuffer) {
        msg.reply('動画のダウンロードに失敗しました。');
        return { reaction: '❌️' };
      }

      const fileId = await uploadGeneratedFile(
        this.ai,
        videoBuffer,
        { mimeType: 'video/mp4', prefix: 'veo', fallbackExtension: 'mp4' },
        (m) => this.log(m)
      );
      if (!fileId) {
        msg.reply('動画のアップロードに失敗しました。');
        return { reaction: '❌️' };
      }

      const replyText = `「${prompt}」で動画を生成しました！`;
      msg.reply(replyText, {
        file: { id: fileId },
      });

      this.log(`Video generation completed for: ${prompt}`);
      return { reaction: '✅' };
    } catch (error) {
      this.log(`Unexpected error during video generation: ${error}`);
      msg.reply('動画生成中に予期しないエラーが発生しました。');
      return { reaction: '❌️' };
    }
  }
}
