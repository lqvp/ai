/**
 * 設定ファイルのスキーマ・既定値・検証。
 * I/O は行わない（純粋な変換のみ）。
 */

export type Config = {
  configVersion?: number;
  host: string;
  serverName?: string;
  i: string;
  aiName?: string[];
  master?: string;
  wsUrl: string;
  apiUrl: string;
  userAgent?: {
    http?: string;
    websocket?: string;
  };
  keywordEnabled: boolean;
  reversiEnabled: boolean;
  notingEnabled: boolean;
  chartEnabled: boolean;
  timeSignalEnabled: boolean;
  serverMonitoring: boolean;
  checkEmojisEnabled?: boolean;
  checkEmojisAtOnce?: boolean;
  aiProvider?: {
    provider?: 'gemini' | 'openai';
    openai?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
    };
  };
  gemini?: {
    enabled?: boolean;
    apiKey?: string;
    model?: string;
    thinkingBudget?: number;
    autoNote?: {
      enabled?: boolean;
      prompt?: string;
      probability?: number;
      intervalMinutes?: number;
      disableNightPosting?: boolean;
      nightHours?: {
        start?: number;
        end?: number;
      };
    };
    randomTalk?: {
      enabled?: boolean;
      probability?: number;
      intervalMinutes?: number;
      followingOnly?: boolean;
      contextRange?: number;
      contextUsageCount?: number;
      enableContext?: boolean;
      /** LLMによるランダムトーク対象ノートの選択（OpenAI互換プロバイダーのみ） */
      llmSelection?: boolean;
    };
    chat?: {
      enabled?: boolean;
      prompt?: string;
      groundingWithGoogleSearch?: boolean;
    };
  };
  aichat?: {
    /** Misskey操作ツール（ノート検索・ユーザー検索・リアクション等） */
    misskeyTools?: {
      enabled?: boolean;
      allowReaction?: boolean;
    };
    /** エピソード記憶（会話終了時にLLMで長期記憶を抽出・保存） */
    episodeMemory?: {
      enabled?: boolean;
      maxMemoriesPerUser?: number;
    };
    /** 気分エンジン（会話・タイムラインから藍の気分を更新し、演技とリアクションに反映） */
    moodEngine?: {
      enabled?: boolean;
      reactionPersonalization?: boolean;
      updateIntervalHours?: number;
    };
    /** TL日記（タイムラインを見て藍の主観日記を生成し、独り言に反映） */
    tlDiary?: {
      enabled?: boolean;
      intervalHours?: number;
      retentionHours?: number;
      maxEntries?: number;
    };
    /** プロアクティブ発話（エピソード記憶に基づき藍からフォローアップを送る） */
    proactiveFollowup?: {
      enabled?: boolean;
      intervalHours?: number;
      maxPerDay?: number;
      cooldownDays?: number;
      userThrottleHours?: number;
    };
  };
  jina?: {
    enabled?: boolean;
    apiKey?: string;
    search?: {
      enabled?: boolean;
      maxResults?: number;
    };
    read?: {
      enabled?: boolean;
      tokenBudget?: number;
    };
    tool?: {
      maxRounds?: number;
    };
  };
  exa?: {
    enabled?: boolean;
    apiKey?: string;
    search?: {
      enabled?: boolean;
      maxResults?: number;
    };
    tool?: {
      maxRounds?: number;
    };
  };
  mecab?: string;
  mecabDic?: string;
  memoryDir?: string;
  followAllowedHosts?: string[];
  followExcludeInstances?: string[];
  mazeEnable?: boolean;
  pollEnable?: boolean;
  postNotPublic?: boolean;
  defaultVisibility?: string;
  earthquakeWarning?: {
    enabled?: boolean;
    minIntensityThreshold?: number;
    minMagunitudeForWeak?: number;
    websocketReconnectMaxAttempts?: number;
    websocketReconnectDelay?: number;
    maxReconnectDelay?: number;
    heartbeatTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    p2pWebSocketUrl?: string;
  };
  kiatsu?: {
    locationCode?: string;
    requestTimeoutMs?: number;
    maxErrorRetries?: number;
    updateIntervalMs?: number;
    postIntervalMs?: number;
    errorCooldownMs?: number;
    minPostLevel?: number;
  };
  weatherAutoNotePref?: string;
  weatherAutoNoteHour?: number;
  imagen?: {
    enabled?: boolean;
    apiKey?: string;
    model?: string;
  };
  veo?: {
    enabled?: boolean;
    apiKey?: string;
    model?: string;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  };
  updateChecker?: {
    enabled?: boolean;
    repository?: string;
    intervalMinutes?: number;
  };
  info?: {
    eventLoopMonitoringInterval?: number;
    enableGCMonitoring?: boolean;
    precision?: number;
  };
};

export type RawConfig = Partial<Config> & {
  /** 旧形式（[http] / [websocket] セクション）との互換用 */
  http?: { userAgent?: string };
  websocket?: { userAgent?: string };
  [key: string]: unknown;
};

export class ConfigError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * 正規化で書き換えるセクションのためのディープコピー。
 * TOML 由来の値はプレーンなオブジェクト・配列・プリミティブなので再帰コピーで十分。
 */
function copyForNormalization(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copyForNormalization);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = copyForNormalization(value[key]);
    }
    return out;
  }
  return value;
}

function normalizeHost(rawHost: string, issues: string[]): string {
  let host = rawHost.trim().replace(/\/+$/, '');

  if (!/^https?:\/\//i.test(host)) {
    issues.push('host は http:// または https:// で始まる必要があります');
    return host;
  }

  try {
    const url = new URL(host);
    if (!url.hostname) {
      issues.push('host にホスト名がありません');
    }
    return host;
  } catch {
    issues.push(`host が URL として不正です: ${rawHost}`);
    return host;
  }
}

function validateAndResolve(input: RawConfig): Config {
  const issues: string[] = [];

  // 正規化結果の書き込み先として入力のコピーを作る（呼び出し元のオブジェクトを壊さない）
  const raw: RawConfig = { ...input };

  if (typeof raw.host !== 'string' || raw.host.trim() === '') {
    issues.push('host は必須です');
  }
  if (typeof raw.i !== 'string' || raw.i.trim() === '') {
    issues.push('i (アクセストークン) は必須です');
  }

  const host = normalizeHost(
    typeof raw.host === 'string' ? raw.host : '',
    issues
  );

  // 旧形式の User-Agent 設定を新形式へ移行する
  let userAgent = raw.userAgent;
  if (!isObject(userAgent)) {
    const legacyHttp = raw.http?.userAgent;
    const legacyWs = raw.websocket?.userAgent;
    if (legacyHttp || legacyWs) {
      userAgent = { http: legacyHttp, websocket: legacyWs };
    }
  }

  const gemini = isObject(raw.gemini)
    ? (copyForNormalization(raw.gemini) as Record<string, unknown>)
    : undefined;
  if (gemini) {
    if (gemini.autoNote != null) {
      const autoNote = copyForNormalization(gemini.autoNote) as Record<
        string,
        unknown
      >;
      gemini.autoNote = autoNote;
      if (autoNote.probability !== undefined) {
        const p = Number(autoNote.probability);
        if (!Number.isFinite(p) || p < 0 || p > 1) {
          issues.push('gemini.autoNote.probability は 0〜1 で指定してください');
        }
        autoNote.probability = clamp(Number.isFinite(p) ? p : 0, 0, 1);
      }
      if (autoNote.intervalMinutes !== undefined) {
        autoNote.intervalMinutes = positive(autoNote.intervalMinutes, 1);
      }
      const nightHours = autoNote.nightHours;
      if (isObject(nightHours)) {
        for (const key of ['start', 'end'] as const) {
          const value = nightHours[key];
          if (value !== undefined) {
            const hour = Number(value);
            if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
              issues.push(
                `gemini.autoNote.nightHours.${key} は 0〜23 で指定してください`
              );
            }
          }
        }
      }
    }

    if (gemini.randomTalk != null) {
      const randomTalk = copyForNormalization(gemini.randomTalk) as Record<
        string,
        unknown
      >;
      gemini.randomTalk = randomTalk;
      if (randomTalk.probability !== undefined) {
        const p = Number(randomTalk.probability);
        if (!Number.isFinite(p) || p < 0 || p > 1) {
          issues.push(
            'gemini.randomTalk.probability は 0〜1 で指定してください'
          );
        }
        randomTalk.probability = clamp(Number.isFinite(p) ? p : 0, 0, 1);
      }
      if (randomTalk.intervalMinutes !== undefined) {
        randomTalk.intervalMinutes = positive(randomTalk.intervalMinutes, 1);
      }
    }
  }

  // 正規化で入力を破壊的に書き換えないよう、対象セクションはコピーしてから扱う
  for (const name of ['jina', 'exa'] as const) {
    const section = copyForNormalization(raw[name]);
    if (!isObject(section)) continue;
    const search = section.search;
    if (isObject(search) && search.maxResults !== undefined) {
      const value = Number(search.maxResults);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        issues.push(`${name}.search.maxResults は 1〜5 で指定してください`);
      }
      search.maxResults = clamp(value, 1, 5);
    }
    const tool = section.tool;
    if (isObject(tool) && tool.maxRounds !== undefined) {
      tool.maxRounds = Math.max(1, Math.floor(Number(tool.maxRounds) || 1));
    }
    raw[name] = section;
  }

  for (const [name, section] of [
    ['kiatsu', raw.kiatsu],
    ['earthquakeWarning', raw.earthquakeWarning],
  ] as const) {
    if (!isObject(section)) continue;
    for (const [key, value] of Object.entries(section)) {
      if (value === undefined) continue;
      if (key.endsWith('Ms') || key.endsWith('Delay')) {
        if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
          issues.push(`${name}.${key} は正の数で指定してください`);
        }
      }
    }
  }

  if (isObject(raw.updateChecker)) {
    const updateChecker = copyForNormalization(
      raw.updateChecker
    ) as NonNullable<RawConfig['updateChecker']>;
    if (updateChecker.intervalMinutes !== undefined) {
      updateChecker.intervalMinutes = positive(
        updateChecker.intervalMinutes,
        60
      );
    }
    if (
      updateChecker.repository !== undefined &&
      !/^[\w.-]+\/[\w.-]+$/.test(String(updateChecker.repository))
    ) {
      issues.push(
        'updateChecker.repository は owner/repo 形式で指定してください'
      );
    }
    raw.updateChecker = updateChecker;
  }

  if (
    isObject(raw.info) &&
    raw.info.eventLoopMonitoringInterval !== undefined
  ) {
    const info = copyForNormalization(raw.info) as NonNullable<
      RawConfig['info']
    >;
    info.eventLoopMonitoringInterval = positive(
      info.eventLoopMonitoringInterval,
      1000
    );
    raw.info = info;
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  let wsUrl = '';
  if (host) {
    try {
      const url = new URL(host);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = url.toString().replace(/\/+$/, '');
    } catch {
      wsUrl = host.replace(/^http/i, 'ws');
    }
  }

  return {
    ...(raw as Config),
    host,
    userAgent: userAgent as Config['userAgent'],
    gemini: gemini as Config['gemini'],
    wsUrl,
    apiUrl: host ? `${host}/api` : '',
  };
}

/**
 * TOML 文字列から設定を解決する。I/O も process.exit も行わない。
 */
export function resolveConfig(raw: RawConfig): Config {
  return validateAndResolve(raw);
}
