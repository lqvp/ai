import chalk from 'chalk';
import got from 'got';
import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import type { DriveFile } from '@/misskey/drive-file.js';
import type { Note } from '@/misskey/note.js';
import log from '@/utils/log.js';

/** Misskey API へ渡すパラメータ。エンドポイント固有のフィールドを許容する。 */
export type ApiParam = Record<string, unknown>;

/** notes/create へ渡すパラメータ。既知のフィールドは型を付け、それ以外も許容する。 */
export type PostParam = {
  text?: string | null;
  cw?: string | null;
  /** Misskey の visibility 値（public/home/followers/specified） */
  visibility?: string;
  localOnly?: boolean;
  replyId?: string;
  renoteId?: string;
  channelId?: string;
  fileIds?: string[];
  poll?: {
    choices: string[];
    expiresAt?: number | null;
    expiredAfter?: number | null;
    multiple?: boolean;
  } | null;
} & ApiParam;

const DEFAULT_API_TIMEOUT_MS = 60_000;

/**
 * Misskey API クライアント
 * API通信の責任を担当
 */
export default class APIClient {
  @bindThis
  private log(msg: string) {
    log(`[${chalk.cyan('APIClient')}]: ${msg}`);
  }

  /**
   * デフォルトのUser-Agentを取得
   */
  private getDefaultUserAgent(): string {
    return (
      config.userAgent?.http || 'Misskey-Ai-Bot(https://github.com/lqvp/ai)'
    );
  }

  /**
   * ファイルをドライブにアップロードします
   */
  @bindThis
  public async upload(
    file: Buffer,
    meta: { filename: string; contentType: string }
  ) {
    try {
      const form = new FormData();
      form.set('i', config.i);
      form.set(
        'file',
        new File([new Uint8Array(file)], meta.filename, {
          type: meta.contentType,
        })
      );

      // got 15 では URL を options オブジェクトに入れられない。
      // また、再試行すると同じファイルが二重に作られるため retry は無効化する。
      const res = await got
        .post(`${config.apiUrl}/drive/files/create`, {
          body: form,
          headers: {
            'User-Agent': this.getDefaultUserAgent(),
          },
          retry: { limit: 0 },
          timeout: { request: DEFAULT_API_TIMEOUT_MS },
        })
        .json<DriveFile>();
      return res;
    } catch (error) {
      this.log(`File upload failed: ${String(error)}`);
      throw error;
    }
  }

  /**
   * 投稿します
   */
  @bindThis
  public async post(param: PostParam): Promise<Note> {
    // 呼び出し元のオブジェクトを破壊しない
    const body = { ...param };

    // リプライの場合は元の投稿の公開範囲を継承するため、visibilityを上書きしない
    if (
      !body.replyId &&
      config.postNotPublic &&
      (!body.visibility || body.visibility == 'public')
    ) {
      body.visibility = 'home';
    }
    if (!body.visibility && config.defaultVisibility) {
      body.visibility = config.defaultVisibility;
    }

    const res = await this.api<{ createdNote: Note }>('notes/create', body);
    return res.createdNote;
  }

  /**
   * 指定ユーザーにチャットメッセージを送信します
   */
  @bindThis
  public sendMessage(userId: string, param: ApiParam) {
    return this.api<unknown>('chat/messages/create-to-user', {
      toUserId: userId,
      ...param,
    });
  }

  /**
   * APIを呼び出します
   */
  @bindThis
  public api<T>(endpoint: string, param?: ApiParam): Promise<T> {
    this.log(`API: ${endpoint}`);
    return got
      .post(`${config.apiUrl}/${endpoint}`, {
        json: { i: config.i, ...param },
        headers: {
          'User-Agent': this.getDefaultUserAgent(),
        },
        timeout: { request: DEFAULT_API_TIMEOUT_MS },
      })
      .json<T>();
  }
}
