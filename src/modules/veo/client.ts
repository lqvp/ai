import got from 'got';
import { sleep } from '@/utils/sleep.js';

export type VeoRequest = {
  instances: Array<{ prompt: string }>;
};

export type VeoStartResponse = {
  name: string;
  error?: { code: number; message: string };
};

export type VeoStatusResponse = {
  name: string;
  done: boolean;
  response?: {
    generateVideoResponse: {
      generatedSamples: Array<{ video: { uri: string } }>;
    };
  };
  error?: { code: number; message: string };
};

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'veo-3.0-fast-generate-preview';
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;
/** 動画1本あたりの上限（メモリ圧迫を防ぐ） */
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/**
 * 動画ダウンロードを許可するホストの許可リスト。
 * API レスポンスの URI は外部入力のため、検証前に任意の URL への取得を防ぐ。
 */
const ALLOWED_VIDEO_HOSTS: ReadonlySet<string> = new Set([
  'generativelanguage.googleapis.com',
]);

/** 許可リストのサフィックス（*.googleapis.com / *.google.com 系）。 */
const ALLOWED_VIDEO_HOST_SUFFIXES: readonly string[] = [
  '.googleapis.com',
  '.google.com',
];

/** API が返した動画 URI が取得先として許可されるか検証する。 */
function isAllowedVideoUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return (
    ALLOWED_VIDEO_HOSTS.has(host) ||
    ALLOWED_VIDEO_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

export type VeoClientOptions = {
  apiKey: string | undefined;
  log: (message: string) => void;
  model?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
};

/**
 * 動画生成を開始し、完成した動画の URI を返す。
 * 失敗した場合は `{ error }` を返す（例外は投げない）。
 */
export async function generateVideo(
  prompt: string,
  options: VeoClientOptions
): Promise<string | { error: string }> {
  const { apiKey, log } = options;

  if (!apiKey) {
    return { error: 'APIキーが設定されていません' };
  }

  const model = options.model || DEFAULT_MODEL;
  const startUrl = `${BASE_URL}/models/${model}:predictLongRunning`;
  const requestBody: VeoRequest = { instances: [{ prompt }] };

  try {
    log(`Veo API request: ${prompt}`);

    const startResponse = await got
      .post(startUrl, {
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        json: requestBody,
        timeout: { request: REQUEST_TIMEOUT_MS },
      })
      .json<VeoStartResponse>();

    if (startResponse.error) {
      return { error: startResponse.error.message };
    }

    const operationName = startResponse.name;
    log(`Video generation started, operation name: ${operationName}`);

    const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);

    while (Date.now() < deadline) {
      await sleep(pollInterval);

      const statusResponse = await got
        .get(`${BASE_URL}/${operationName}`, {
          headers: { 'x-goog-api-key': apiKey },
          timeout: { request: REQUEST_TIMEOUT_MS },
        })
        .json<VeoStatusResponse>();

      if (!statusResponse.done) {
        log('Video generation in progress...');
        continue;
      }

      if (statusResponse.error) {
        return { error: statusResponse.error.message };
      }

      const videoUri =
        statusResponse.response?.generateVideoResponse?.generatedSamples?.[0]
          ?.video?.uri;

      if (!videoUri) {
        return { error: '動画URIが取得できませんでした' };
      }

      log(`Video is ready, URI: ${videoUri}`);
      return videoUri;
    }

    return {
      error:
        '動画生成がタイムアウトしました（しばらくしてから再試行してください）',
    };
  } catch (error: unknown) {
    log(`Veo API error: ${String(error)}`);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** 生成済み動画をダウンロードする。失敗時は null。 */
export async function downloadVideo(
  videoUri: string,
  apiKey: string | undefined,
  log: (message: string) => void = () => {}
): Promise<Buffer | null> {
  try {
    if (!isAllowedVideoUri(videoUri)) {
      log(`Refusing to download video from disallowed host: ${videoUri}`);
      return null;
    }
    const response = await got(videoUri, {
      headers: apiKey ? { 'x-goog-api-key': apiKey } : {},
      responseType: 'buffer',
      timeout: { request: REQUEST_TIMEOUT_MS },
      // リダイレクト自動追従で許可外ホストへ接続 (APIキー送信) しないよう、
      // リダイレクト先にも許可リスト検査を適用する
      hooks: {
        beforeRedirect: [
          (redirectOptions) => {
            const redirectUrl = redirectOptions.url
              ? String(redirectOptions.url)
              : '';
            if (!isAllowedVideoUri(redirectUrl)) {
              throw new Error(
                `Refusing to follow redirect to disallowed host: ${redirectUrl}`
              );
            }
          },
        ],
      },
    });

    const declaredLength = Number(response.headers['content-length'] ?? 0);
    if (declaredLength > MAX_VIDEO_BYTES) {
      log(`Video is too large: ${declaredLength} bytes`);
      return null;
    }

    const buffer = Buffer.from(response.body);
    if (buffer.length > MAX_VIDEO_BYTES) {
      log(`Video is too large: ${buffer.length} bytes`);
      return null;
    }

    return buffer;
  } catch (error) {
    log(`Failed to download video: ${String(error)}`);
    return null;
  }
}
