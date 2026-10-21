import type APIClient from '@/api/APIClient.js';
import type { Note } from '@/misskey/note.js';
import urlToBase64 from '@/utils/url2base64.js';

export type Base64File = {
  type: string;
  base64: string;
  url?: string;
};

type NoteWithFiles = Partial<Note & { files: any[] }>;

export type FetchNoteFilesOptions = {
  /** 取得したファイル URL を結果に含めるか */
  includeUrl?: boolean;
  /** 画像 MIME タイプを正規化するか */
  normalizeImageType?: boolean;
  /** ログ出力（省略可） */
  log?: (message: string) => void;
};

const MIME_ALIASES: Record<string, string> = {
  'image/x-webp': 'image/webp',
  'image/jpg': 'image/jpeg',
};

function normalizeImageType(type: string): string {
  return MIME_ALIASES[type] ?? type;
}

function pickFileInfo(file: any): { type?: string; url?: string } {
  const type = typeof file?.type === 'string' ? file.type : undefined;

  let url: string | undefined;
  if (typeof file?.thumbnailUrl === 'string' && file.thumbnailUrl) {
    url = file.thumbnailUrl;
  } else if (typeof file?.url === 'string' && file.url) {
    url = file.url;
  }

  return { type, url };
}

/**
 * ノートに添付されたファイルを base64 化して返す。
 *
 * aichat / imagen で同じ処理が重複していたため共通化した。
 * 1ファイルの取得失敗は他のファイルを止めない。
 */
export async function fetchNoteFiles(
  api: APIClient['api'],
  noteId: string,
  options: FetchNoteFilesOptions = {}
): Promise<Base64File[]> {
  const {
    includeUrl = false,
    normalizeImageType: shouldNormalize,
    log,
  } = options;

  const note = await api<NoteWithFiles>('notes/show', { noteId });
  if (!note?.files?.length) return [];

  const results: Base64File[] = [];

  for (const file of note.files) {
    const { type, url } = pickFileInfo(file);
    if (!type || !url) continue;

    const resolvedType = shouldNormalize ? normalizeImageType(type) : type;

    try {
      log?.(`fileUrl: ${url}`);
      const base64 = await urlToBase64(url);
      results.push(
        includeUrl
          ? { type: resolvedType, base64, url }
          : { type: resolvedType, base64 }
      );
    } catch (err) {
      log?.(
        `Failed to fetch note file: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return results;
}
