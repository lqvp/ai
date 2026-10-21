import type 藍 from '@/ai.js';

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/x-webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/**
 * MIME タイプから拡張子を決める。未知のものは `fallback`。
 */
export function mimeToExtension(mimeType: string, fallback = 'bin'): string {
  return MIME_TO_EXTENSION[mimeType.split(';')[0].trim()] ?? fallback;
}

export type UploadOptions = {
  mimeType: string;
  /** ファイル名の接頭辞（例: `imagen`） */
  prefix: string;
  fallbackExtension?: string;
};

/**
 * 生成したバイナリを Misskey のドライブへアップロードし、ファイルIDを返す。
 * 失敗した場合はログを出して `null` を返す（呼び出し側の投稿処理は止めない）。
 */
export async function uploadGeneratedFile(
  ai: 藍,
  buffer: Buffer,
  options: UploadOptions,
  log: (message: string) => void = () => {}
): Promise<string | null> {
  const extension = mimeToExtension(
    options.mimeType,
    options.fallbackExtension ?? 'bin'
  );
  const filename = `${options.prefix}_${Date.now()}.${extension}`;

  try {
    const file = (await ai.upload(buffer, {
      filename,
      contentType: options.mimeType,
    })) as { id: string };
    return file.id;
  } catch (error) {
    log(`Failed to upload ${filename} to Misskey: ${String(error)}`);
    return null;
  }
}
