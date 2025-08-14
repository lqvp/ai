import got from 'got';
import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Friend from '@/friend.js';
import Message from '@/message.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import urlToBase64 from '@/utils/url2base64.js';

// 従来のImagen API用の型定義
type ImagenRequest = {
  instances: Array<{
    prompt: string;
  }>;
  parameters: {
    sampleCount: number;
    aspectRatio?: string;
    personGeneration?: string;
  };
};

type ImagenResponse = {
  predictions?: Array<{
    bytesBase64Encoded?: string;
    mimeType?: string;
  }>;
  error?: {
    code: number;
    message: string;
  };
};

// Gemini API用の型定義（画像生成）
type GeminiImageGenerationRequest = {
  contents: Array<{
    parts: Array<{
      text?: string;
      inlineData?: {
        mimeType: string;
        data: string;
      };
    }>;
  }>;
  generationConfig: {
    responseModalities: string[];
  };
};

type GeminiImageGenerationResponse = {
  candidates?: Array<{
    content: {
      parts: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string;
        };
      }>;
    };
  }>;
  error?: {
    code: number;
    message: string;
  };
};

type ImagenApiResponse = ImagenResponse | GeminiImageGenerationResponse | null;

// Base64File型定義
type Base64File = {
  type: string;
  base64: string;
};

// デフォルト設定値
const DEFAULTS = {
  SAMPLE_COUNT: 1,
  ASPECT_RATIO: '1:1',
  PERSON_GENERATION: 'allow_adult',
} as const;

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
      return {};
    }

    return {
      mentionHook: this.mentionHook,
    };
  }

  @bindThis
  private async isFollowing(userId: string): Promise<boolean> {
    if (userId === this.ai.account.id) return true;
    try {
      const relation = await this.ai.api<Array<{ isFollowing?: boolean }>>(
        'users/relation',
        {
          userId,
        }
      );
      return relation?.[0]?.isFollowing === true;
    } catch (error) {
      this.log(`Failed to check following status: ${error}`);
      return false;
    }
  }

  @bindThis
  private async generateImageWithGemini(
    prompt: string,
    files: Base64File[]
  ): Promise<GeminiImageGenerationResponse | null> {
    // APIキーの存在確認
    if (!this.apiKey) {
      return {
        error: {
          code: 500,
          message: 'APIキーが設定されていません',
        },
      };
    }

    const model = 'gemini-2.0-flash-preview-image-generation';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    // 画像付きの場合はGemini APIを使用
    const parts: Array<{
      text?: string;
      inlineData?: {
        mimeType: string;
        data: string;
      };
    }> = [];

    // プロンプトを追加
    if (prompt) {
      parts.push({ text: prompt });
    }

    // 画像ファイルを追加
    for (const file of files) {
      // デバッグ情報を追加
      this.log(
        `Processing file: type=${file.type}, base64 length=${file.base64.length}`
      );

      // MIMEタイプを正規化（WebPの場合はimage/webpに統一）
      let normalizedMimeType = file.type;
      if (file.type === 'image/webp' || file.type === 'image/x-webp') {
        normalizedMimeType = 'image/webp';
      }

      parts.push({
        inlineData: {
          mimeType: normalizedMimeType,
          data: file.base64,
        },
      });
    }

    const requestBody: GeminiImageGenerationRequest = {
      contents: [
        {
          parts: parts,
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    };

    try {
      this.log(`Gemini API request: ${prompt} with ${files.length} images`);
      this.log(
        `Request body structure: ${JSON.stringify({
          contentsCount: requestBody.contents.length,
          partsCount: requestBody.contents[0].parts.length,
          hasText: requestBody.contents[0].parts.some((p) => p.text),
          hasImages: requestBody.contents[0].parts.some((p) => p.inlineData),
          responseModalities: requestBody.generationConfig.responseModalities,
        })}`
      );

      // 最初の画像のBase64データの最初の100文字をログ出力（デバッグ用）
      const firstImage = requestBody.contents[0].parts.find(
        (p) => p.inlineData
      );
      if (firstImage?.inlineData) {
        this.log(`First image MIME type: ${firstImage.inlineData.mimeType}`);
        this.log(
          `First image base64 preview: ${firstImage.inlineData.data.substring(
            0,
            100
          )}...`
        );
      }

      const response = await got
        .post(apiUrl, {
          headers: {
            'x-goog-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          json: requestBody,
          timeout: {
            request: 60000, // 60秒タイムアウト
          },
          retry: {
            limit: 2,
          },
        })
        .json<GeminiImageGenerationResponse>();

      return response;
    } catch (error: any) {
      this.log(`Gemini API error: ${error}`);

      // より詳細なエラー情報を取得
      if (error?.response) {
        try {
          const errorBody = await error.response.text();
          this.log(`Error response body: ${errorBody}`);
        } catch (e) {
          this.log(`Could not read error response body: ${e}`);
        }
      }

      const message = error instanceof Error ? error.message : String(error);
      return {
        error: {
          code: error?.response?.statusCode ?? 500,
          message,
        },
      };
    }
  }

  @bindThis
  private async generateImage(prompt: string): Promise<ImagenApiResponse> {
    // APIキーの存在確認
    if (!this.apiKey) {
      return {
        error: {
          code: 500,
          message: 'APIキーが設定されていません',
        },
      };
    }

    const model = config.imagen?.model || 'imagen-3.0-generate-002';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`;

    const requestBody: ImagenRequest = {
      instances: [{ prompt }],
      parameters: {
        sampleCount: DEFAULTS.SAMPLE_COUNT,
        aspectRatio: DEFAULTS.ASPECT_RATIO,
        personGeneration: DEFAULTS.PERSON_GENERATION,
      },
    };

    try {
      this.log(`Imagen API request: ${prompt}`);

      const response = await got
        .post(apiUrl, {
          headers: {
            'x-goog-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          json: requestBody,
          timeout: {
            request: 60000, // 60秒タイムアウト
          },
          retry: {
            limit: 2,
          },
        })
        .json<ImagenResponse>();

      return response;
    } catch (error: any) {
      this.log(`Imagen API error: ${error}`);
      const message = error instanceof Error ? error.message : String(error);
      return {
        error: {
          code: error?.response?.statusCode ?? 500,
          message,
        },
      };
    }
  }

  @bindThis
  private async getNoteFiles(noteId: string): Promise<Base64File[]> {
    try {
      const noteData = await this.ai.api<Partial<{ files: any[] }>>(
        'notes/show',
        { noteId }
      );

      let files: Base64File[] = [];
      if (noteData && noteData.files) {
        for (let i = 0; i < noteData.files.length; i++) {
          let fileType: string | undefined;
          let fileUrl: string | undefined;

          if (noteData.files[i].hasOwnProperty('type')) {
            fileType = noteData.files[i].type;
          }

          if (
            noteData.files[i].hasOwnProperty('thumbnailUrl') &&
            noteData.files[i].thumbnailUrl
          ) {
            fileUrl = noteData.files[i].thumbnailUrl;
          } else if (
            noteData.files[i].hasOwnProperty('url') &&
            noteData.files[i].url
          ) {
            fileUrl = noteData.files[i].url;
          }

          if (fileType !== undefined && fileUrl !== undefined) {
            try {
              this.log('Processing file: ' + fileUrl);
              this.log(`File type: ${fileType}`);

              const base64Data = await urlToBase64(fileUrl);
              this.log(`Base64 data length: ${base64Data.length}`);

              // MIMEタイプを正規化
              let normalizedType = fileType;
              if (fileType === 'image/webp' || fileType === 'image/x-webp') {
                normalizedType = 'image/webp';
              } else if (
                fileType === 'image/jpeg' ||
                fileType === 'image/jpg'
              ) {
                normalizedType = 'image/jpeg';
              } else if (fileType === 'image/png') {
                normalizedType = 'image/png';
              }

              this.log(`Normalized MIME type: ${normalizedType}`);

              const base64file: Base64File = {
                type: normalizedType,
                base64: base64Data,
              };
              files.push(base64file);
            } catch (err: unknown) {
              if (err instanceof Error) {
                this.log(`Failed to process file: ${err.name}\n${err.message}`);
              }
            }
          }
        }
      }

      this.log(`Retrieved ${files.length} files from note`);
      return files;
    } catch (error) {
      this.log(`Error getting note files: ${error}`);
      return [];
    }
  }

  @bindThis
  private async getQuotedNoteFiles(quoteId: string): Promise<Base64File[]> {
    try {
      this.log('Getting files from quoted note: ' + quoteId);

      const quotedNoteData = await this.ai.api<Partial<{ files: any[] }>>(
        'notes/show',
        { noteId: quoteId }
      );

      let files: Base64File[] = [];
      if (quotedNoteData && quotedNoteData.files) {
        for (let i = 0; i < quotedNoteData.files.length; i++) {
          let fileType: string | undefined;
          let fileUrl: string | undefined;

          if (quotedNoteData.files[i].hasOwnProperty('type')) {
            fileType = quotedNoteData.files[i].type;
          }

          if (
            quotedNoteData.files[i].hasOwnProperty('thumbnailUrl') &&
            quotedNoteData.files[i].thumbnailUrl
          ) {
            fileUrl = quotedNoteData.files[i].thumbnailUrl;
          } else if (
            quotedNoteData.files[i].hasOwnProperty('url') &&
            quotedNoteData.files[i].url
          ) {
            fileUrl = quotedNoteData.files[i].url;
          }

          if (fileType !== undefined && fileUrl !== undefined) {
            try {
              this.log('Quoted note fileUrl:' + fileUrl);
              this.log(`Quoted file type: ${fileType}`);

              const base64Data = await urlToBase64(fileUrl);
              this.log(`Quoted file base64 length: ${base64Data.length}`);

              // MIMEタイプを正規化
              let normalizedType = fileType;
              if (fileType === 'image/webp' || fileType === 'image/x-webp') {
                normalizedType = 'image/webp';
              } else if (
                fileType === 'image/jpeg' ||
                fileType === 'image/jpg'
              ) {
                normalizedType = 'image/jpeg';
              } else if (fileType === 'image/png') {
                normalizedType = 'image/png';
              }

              this.log(`Quoted file normalized MIME type: ${normalizedType}`);

              const base64file: Base64File = {
                type: normalizedType,
                base64: base64Data,
              };
              files.push(base64file);
            } catch (err: unknown) {
              if (err instanceof Error) {
                this.log(
                  `Failed to process quoted note file: ${err.name}\n${err.message}`
                );
              }
            }
          }
        }
      }

      this.log(`Retrieved ${files.length} files from quoted note`);
      return files;
    } catch (error) {
      this.log(`Error getting quoted note files: ${error}`);
      return [];
    }
  }

  @bindThis
  private async uploadToMisskey(
    imageBase64: string,
    mimeType: string
  ): Promise<string | null> {
    try {
      // Base64をBufferに変換
      const buffer = Buffer.from(imageBase64, 'base64');

      // ファイル拡張子を決定
      const mimeToExt: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/bmp': 'bmp',
      };
      const extension = mimeToExt[mimeType] || 'jpg';
      const filename = `imagen_${Date.now()}.${extension}`;

      // Misskeyのドライブにアップロード
      const file = (await this.ai.upload(buffer, {
        filename,
        contentType: mimeType,
      })) as { id: string };

      return file.id;
    } catch (error) {
      this.log(`Failed to upload image to Misskey: ${error}`);
      return null;
    }
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
    if (!match || !match[1]) {
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

    // 生成開始
    this.log(`Starting image generation for: ${prompt}`);

    // 生成中リアクションを追加
    this.ai.api('notes/reactions/create', {
      noteId: msg.id,
      reaction: '🎨',
    });

    try {
      // 画像ファイルを取得（現在のノートから）
      const files = await this.getNoteFiles(msg.id);

      // 引用先の画像ファイルも取得
      let quotedFiles: Base64File[] = [];
      if (msg.quoteId) {
        quotedFiles = await this.getQuotedNoteFiles(msg.quoteId);
        this.log(`Found ${quotedFiles.length} quoted files`);
      }

      // すべての画像ファイルを統合
      const allFiles = [...files, ...quotedFiles];
      this.log(
        `Total files to process: ${allFiles.length} (current: ${files.length}, quoted: ${quotedFiles.length})`
      );

      let response: ImagenApiResponse;

      // 画像がある場合はGemini API、ない場合は従来のImagen APIを使用
      if (allFiles.length > 0) {
        this.log(`Using Gemini API with ${allFiles.length} images`);
        response = await this.generateImageWithGemini(prompt, allFiles);
      } else {
        this.log('Using traditional Imagen API');
        response = await this.generateImage(prompt);
      }

      if (!response || response.error) {
        const errorMsg = response?.error?.message || '不明なエラー';
        this.log(`Image generation failed: ${errorMsg}`);
        msg.reply(`画像生成でエラーが発生しました: ${errorMsg}`);
        return { reaction: '❌️' };
      }

      // Gemini APIの応答を処理
      if ('candidates' in response && response.candidates) {
        if (response.candidates.length === 0) {
          this.log('No image generated from Gemini API');
          msg.reply(
            '画像が生成されませんでした。プロンプトを見直してください。'
          );
          return { reaction: '❌️' };
        }

        const candidate = response.candidates[0];
        if (!candidate.content || !candidate.content.parts) {
          this.log('Invalid Gemini API response structure');
          msg.reply('画像データが取得できませんでした。');
          return { reaction: '❌️' };
        }

        // 画像データを探す
        let imageData: string | null = null;
        let mimeType = 'image/png';

        for (const part of candidate.content.parts) {
          if (part.inlineData && part.inlineData.data) {
            imageData = part.inlineData.data;
            mimeType = part.inlineData.mimeType || 'image/png';
            break;
          }
        }

        if (!imageData) {
          this.log('No image data in Gemini API response');
          msg.reply('画像データが取得できませんでした。');
          return { reaction: '❌️' };
        }

        // 画像をドライブにアップロード
        const fileId = await this.uploadToMisskey(imageData, mimeType);

        if (!fileId) {
          msg.reply('画像のアップロードに失敗しました。');
          return { reaction: '❌️' };
        }

        // 画像付きでリプライ
        const replyText = `「${prompt}」で画像を生成しました！`;
        const file = { id: fileId };
        msg.reply(replyText, {
          file: file,
        });

        this.log(`Image generation completed for: ${prompt}`);
        return { reaction: 'like' };
      }

      // 従来のImagen APIの応答を処理
      if ('predictions' in response && response.predictions) {
        if (response.predictions.length === 0) {
          this.log('No image generated from Imagen API');
          msg.reply(
            '画像が生成されませんでした。プロンプトを見直してください。'
          );
          return { reaction: '❌️' };
        }

        const prediction = response.predictions[0];
        if (!prediction.bytesBase64Encoded) {
          this.log('No image data in Imagen API response');
          msg.reply('画像データが取得できませんでした。');
          return { reaction: '❌️' };
        }

        // 画像をドライブにアップロード
        const mimeType = prediction.mimeType || 'image/png';
        const fileId = await this.uploadToMisskey(
          prediction.bytesBase64Encoded,
          mimeType
        );

        if (!fileId) {
          msg.reply('画像のアップロードに失敗しました。');
          return { reaction: '❌️' };
        }

        // 画像付きでリプライ
        const replyText = `「${prompt}」で画像を生成しました！`;
        const file = { id: fileId };
        msg.reply(replyText, {
          file: file,
        });

        this.log(`Image generation completed for: ${prompt}`);
        return { reaction: 'like' };
      }

      this.log('Unexpected response format');
      msg.reply('予期しない応答形式です。');
      return { reaction: '❌️' };
    } catch (error) {
      this.log(`Unexpected error during image generation: ${error}`);
      msg.reply('画像生成中に予期しないエラーが発生しました。');
      return { reaction: '❌️' };
    }
  }
}
