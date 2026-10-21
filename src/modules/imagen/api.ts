import got from 'got';

/** 従来の Imagen API（`models/*:predict`）のリクエスト */
export type ImagenRequest = {
  instances: Array<{ prompt: string }>;
  parameters: {
    sampleCount: number;
    aspectRatio?: string;
    personGeneration?: string;
  };
};

export type ImagenResponse = {
  predictions?: Array<{
    bytesBase64Encoded?: string;
    mimeType?: string;
  }>;
  error?: {
    code: number;
    message: string;
  };
};

export type GeminiPart = {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
};

/** Gemini API（`models/*:generateContent`）で画像を生成するリクエスト */
export type GeminiImageGenerationRequest = {
  contents: Array<{ parts: GeminiPart[] }>;
  generationConfig: {
    responseModalities: string[];
  };
};

export type GeminiImageGenerationResponse = {
  candidates?: Array<{
    content: {
      parts: GeminiPart[];
    };
  }>;
  error?: {
    code: number;
    message: string;
  };
};

export type ImagenApiResponse =
  | ImagenResponse
  | GeminiImageGenerationResponse
  | null;

export type Attachment = {
  type: string;
  base64: string;
};

export type ImagenApiOptions = {
  apiKey: string | undefined;
  log: (message: string) => void;
  /** 従来 API のモデル（既定: config.imagen.model） */
  model?: string;
  /** 画像入力つき生成に使う Gemini のモデル */
  geminiModel?: string;
  timeoutMs?: number;
};

const DEFAULTS = {
  SAMPLE_COUNT: 1,
  ASPECT_RATIO: '1:1',
  PERSON_GENERATION: 'allow_adult',
  GEMINI_MODEL: 'gemini-2.5-flash-image-preview',
  TIMEOUT_MS: 60_000,
} as const;

const NO_API_KEY = {
  error: { code: 500, message: 'APIキーが設定されていません' },
} as const;

function errorResponse(error: any): {
  error: { code: number; message: string };
} {
  return {
    error: {
      code: error?.response?.statusCode ?? 500,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * 画像を入力にした Gemini 画像生成。
 * WebP などの MIME タイプは送信前に正規化する。
 */
export async function generateImageWithGemini(
  prompt: string,
  files: Attachment[],
  options: ImagenApiOptions
): Promise<
  GeminiImageGenerationResponse | { error: { code: number; message: string } }
> {
  const { apiKey, log } = options;

  if (!apiKey) return NO_API_KEY;

  const model = options.geminiModel ?? DEFAULTS.GEMINI_MODEL;
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const parts: GeminiPart[] = [];
  if (prompt) parts.push({ text: prompt });

  for (const file of files) {
    log(
      `Processing file: type=${file.type}, base64 length=${file.base64.length}`
    );

    const normalizedMimeType =
      file.type === 'image/x-webp' ? 'image/webp' : file.type;

    parts.push({
      inlineData: { mimeType: normalizedMimeType, data: file.base64 },
    });
  }

  const requestBody: GeminiImageGenerationRequest = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };

  try {
    log(`Gemini API request: ${prompt} with ${files.length} images`);

    return await got
      .post(apiUrl, {
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        json: requestBody,
        timeout: { request: options.timeoutMs ?? DEFAULTS.TIMEOUT_MS },
        retry: { limit: 2 },
      })
      .json<GeminiImageGenerationResponse>();
  } catch (error: any) {
    log(`Gemini API error: ${String(error)}`);

    try {
      const body = await error?.response?.text?.();
      if (body) log(`Error response body: ${body}`);
    } catch {
      // レスポンスボディが読めなくてもエラー処理は続行する
    }

    return errorResponse(error);
  }
}

/**
 * 従来の Imagen API でプロンプトから画像を生成する。
 */
export async function generateImage(
  prompt: string,
  options: ImagenApiOptions
): Promise<ImagenResponse | { error: { code: number; message: string } }> {
  const { apiKey, log } = options;

  if (!apiKey) return NO_API_KEY;

  const model = options.model || 'imagen-3.0-generate-002';
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
    log(`Imagen API request: ${prompt}`);

    return await got
      .post(apiUrl, {
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        json: requestBody,
        timeout: { request: options.timeoutMs ?? DEFAULTS.TIMEOUT_MS },
        retry: { limit: 2 },
      })
      .json<ImagenResponse>();
  } catch (error: any) {
    log(`Imagen API error: ${String(error)}`);
    return errorResponse(error);
  }
}

/**
 * レスポンスから画像（MIME と Base64）を取り出す。
 */
export function extractImage(
  response: ImagenApiResponse
): { base64: string; mimeType: string } | null {
  if (response == null) return null;

  if ('candidates' in response) {
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData) {
        return {
          base64: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        };
      }
    }
    return null;
  }

  const prediction = (response as ImagenResponse).predictions?.[0];
  if (prediction?.bytesBase64Encoded) {
    return {
      base64: prediction.bytesBase64Encoded,
      mimeType: prediction.mimeType ?? 'image/png',
    };
  }

  return null;
}

export { DEFAULTS as IMAGEN_DEFAULTS };
