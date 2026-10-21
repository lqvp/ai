import config from '@/config.js';

export function formatMemoryUsage(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const precision = config.info?.precision ?? FORMAT_DEFAULTS.precision;
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(precision))} ${
    sizes[i]
  }`;
}

export function formatUptime(uptime: number): string {
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  return [
    days > 0 ? `${days}日` : '',
    hours > 0 ? `${hours}時間` : '',
    minutes > 0 ? `${minutes}分` : '',
    `${seconds}秒`,
  ]
    .filter(Boolean)
    .join('');
}

export function formatDate(date: Date | null | undefined): string {
  if (!date) return '不明';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

// 設定表示用の定数とヘルパー関数
export const CONFIG_LABELS = {
  sections: {
    basicFeatures: '**基本機能:**',
    gameFeatures: '**ゲーム機能:**',
    postSettings: '**投稿設定:**',
    aiFeatures: '**AI機能:**',
    earthquake: '**地震速報:**',
    pressure: '**気圧監視:**',
    others: '**その他:**',
  },
  basic: {
    keywordEnabled: 'キーワード検索',
    reversiEnabled: 'リバーシ',
    notingEnabled: '自動単語',
    chartEnabled: 'チャート',
    timeSignalEnabled: '時刻通知',
    serverMonitoring: 'サーバー監視',
    checkEmojisEnabled: '絵文字チェック',
  },
  game: {
    mazeEnable: '迷路',
    pollEnable: '投票',
  },
  post: {
    postNotPublic: 'パブリック投稿制限',
    defaultVisibility: 'デフォルト公開範囲',
  },
  ai: {
    enabled: 'Gemini',
    model: 'モデル',
    thinkingBudget: '思考予算',
    autoNoteEnabled: '自動ノート',
    autoNoteProbability: '投稿確率',
    autoNoteInterval: '投稿間隔',
    autoNoteDisableNight: '夜間投稿無効',
    randomTalkEnabled: 'ランダムトーク',
    randomTalkProbability: '反応確率',
    randomTalkFollowingOnly: 'フォロー限定',
    chatEnabled: 'チャット',
    chatGrounding: 'Google検索連携',
  },
  earthquake: {
    enable: '地震速報',
    minIntensity: '最小震度閾値',
    minMagnitude: '弱震時の最小規模',
  },
  pressure: {
    minPostLevel: '最小投稿レベル',
    updateInterval: '更新間隔',
  },
  others: {
    weatherAutoNoteHour: '天気自動投稿時刻',
    weatherAutoNotePref: '天気地域設定',
    imagenEnabled: 'Imagen',
    imagenModel: 'Imagenモデル',
    veoEnabled: 'Veo',
    veoModel: 'Veoモデル',
  },
} as const;

export const FORMAT_DEFAULTS = {
  notSet: '未設定',
  enabled: '✅',
  disabled: '❌',
  precision: 2,
} as const;

function safeConfigValue<T>(
  value: T | null | undefined,
  fallback: string = FORMAT_DEFAULTS.notSet
): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function formatBooleanSetting(value: boolean | undefined): string {
  return value ? FORMAT_DEFAULTS.enabled : FORMAT_DEFAULTS.disabled;
}

export function formatBasicFeatures(): string {
  const lines: string[] = [
    CONFIG_LABELS.sections.basicFeatures,
    `- ${CONFIG_LABELS.basic.keywordEnabled}: ${formatBooleanSetting(
      config.keywordEnabled
    )}`,
    `- ${CONFIG_LABELS.basic.reversiEnabled}: ${formatBooleanSetting(
      config.reversiEnabled
    )}`,
    `- ${CONFIG_LABELS.basic.notingEnabled}: ${formatBooleanSetting(
      config.notingEnabled
    )}`,
    `- ${CONFIG_LABELS.basic.chartEnabled}: ${formatBooleanSetting(
      config.chartEnabled
    )}`,
    `- ${CONFIG_LABELS.basic.timeSignalEnabled}: ${formatBooleanSetting(
      config.timeSignalEnabled
    )}`,
    `- ${CONFIG_LABELS.basic.serverMonitoring}: ${formatBooleanSetting(
      config.serverMonitoring
    )}`,
    `- ${CONFIG_LABELS.basic.checkEmojisEnabled}: ${formatBooleanSetting(
      config.checkEmojisEnabled
    )}`,
  ];
  return lines.join('\n') + '\n';
}

export function formatGameFeatures(): string {
  const lines: string[] = [
    CONFIG_LABELS.sections.gameFeatures,
    `- ${CONFIG_LABELS.game.mazeEnable}: ${formatBooleanSetting(
      config.mazeEnable
    )}`,
    `- ${CONFIG_LABELS.game.pollEnable}: ${formatBooleanSetting(
      config.pollEnable
    )}`,
  ];
  return lines.join('\n') + '\n';
}

export function formatPostSettings(): string {
  const lines: string[] = [
    CONFIG_LABELS.sections.postSettings,
    `- ${CONFIG_LABELS.post.postNotPublic}: ${formatBooleanSetting(
      config.postNotPublic
    )}`,
    `- ${CONFIG_LABELS.post.defaultVisibility}: ${safeConfigValue(
      config.defaultVisibility
    )}`,
  ];
  return lines.join('\n') + '\n';
}

export function formatAIFeatures(): string {
  if (!config.gemini) return '';

  const lines: string[] = [CONFIG_LABELS.sections.aiFeatures];

  lines.push(
    `- ${CONFIG_LABELS.ai.enabled}: ${formatBooleanSetting(
      config.gemini.enabled
    )}`
  );
  lines.push(
    `- ${CONFIG_LABELS.ai.model}: ${safeConfigValue(config.gemini.model)}`
  );
  lines.push(
    `- ${CONFIG_LABELS.ai.thinkingBudget}: ${safeConfigValue(
      config.gemini.thinkingBudget
    )}`
  );

  if (config.gemini.autoNote) {
    lines.push(
      `- ${CONFIG_LABELS.ai.autoNoteEnabled}: ${formatBooleanSetting(
        config.gemini.autoNote.enabled
      )}`
    );
    lines.push(
      `- ${CONFIG_LABELS.ai.autoNoteProbability}: ${safeConfigValue(
        config.gemini.autoNote.probability
      )}`
    );
    lines.push(
      `- ${CONFIG_LABELS.ai.autoNoteInterval}: ${safeConfigValue(
        config.gemini.autoNote.intervalMinutes
      )}分`
    );
    lines.push(
      `- ${CONFIG_LABELS.ai.autoNoteDisableNight}: ${formatBooleanSetting(
        config.gemini.autoNote.disableNightPosting
      )}`
    );
  }

  if (config.gemini.randomTalk) {
    lines.push(
      `- ${CONFIG_LABELS.ai.randomTalkEnabled}: ${formatBooleanSetting(
        config.gemini.randomTalk.enabled
      )}`
    );
    lines.push(
      `- ${CONFIG_LABELS.ai.randomTalkProbability}: ${safeConfigValue(
        config.gemini.randomTalk.probability
      )}`
    );
    lines.push(
      `- ${CONFIG_LABELS.ai.randomTalkFollowingOnly}: ${formatBooleanSetting(
        config.gemini.randomTalk.followingOnly
      )}`
    );
  }

  if (config.gemini.chat) {
    lines.push(
      `- ${CONFIG_LABELS.ai.chatEnabled}: ${formatBooleanSetting(
        config.gemini.chat.enabled
      )}`
    );
    lines.push(
      `- ${CONFIG_LABELS.ai.chatGrounding}: ${formatBooleanSetting(
        config.gemini.chat.groundingWithGoogleSearch
      )}`
    );
  }

  return lines.join('\n') + '\n';
}

export function formatEarthquakeSettings(): string {
  const lines: string[] = [CONFIG_LABELS.sections.earthquake];

  // 地震速報機能の有効/無効
  lines.push(
    `- ${CONFIG_LABELS.earthquake.enable}: ${formatBooleanSetting(
      config.earthquakeWarning?.enabled
    )}`
  );

  // 地震警報の詳細設定（設定されている場合のみ）
  if (config.earthquakeWarning) {
    lines.push(
      `- ${CONFIG_LABELS.earthquake.minIntensity}: ${safeConfigValue(
        config.earthquakeWarning.minIntensityThreshold
      )}`
    );
    lines.push(
      `- ${CONFIG_LABELS.earthquake.minMagnitude}: ${safeConfigValue(
        config.earthquakeWarning.minMagunitudeForWeak
      )}`
    );
  }

  return lines.join('\n') + '\n';
}

export function formatPressureSettings(): string {
  if (!config.kiatsu) return '';

  const updateIntervalMinutes = config.kiatsu.updateIntervalMs
    ? Math.floor(config.kiatsu.updateIntervalMs / 60000) + '分'
    : FORMAT_DEFAULTS.notSet;

  const lines: string[] = [
    CONFIG_LABELS.sections.pressure,
    `- ${CONFIG_LABELS.pressure.minPostLevel}: ${safeConfigValue(
      config.kiatsu.minPostLevel
    )}`,
    `- ${CONFIG_LABELS.pressure.updateInterval}: ${updateIntervalMinutes}`,
  ];

  return lines.join('\n') + '\n';
}

export function formatOtherSettings(): string {
  const lines: string[] = [CONFIG_LABELS.sections.others];

  const weatherHour =
    config.weatherAutoNoteHour !== null &&
    config.weatherAutoNoteHour !== undefined
      ? `${config.weatherAutoNoteHour}時`
      : FORMAT_DEFAULTS.notSet;
  lines.push(`- ${CONFIG_LABELS.others.weatherAutoNoteHour}: ${weatherHour}`);
  lines.push(
    `- ${CONFIG_LABELS.others.weatherAutoNotePref}: ${safeConfigValue(
      config.weatherAutoNotePref
    )}`
  );

  if (config.imagen) {
    lines.push(
      `- ${CONFIG_LABELS.others.imagenEnabled}: ${formatBooleanSetting(
        config.imagen.enabled
      )}`
    );
    lines.push(
      `- ${CONFIG_LABELS.others.imagenModel}: ${safeConfigValue(
        config.imagen.model
      )}`
    );
  }

  if (config.veo) {
    lines.push(
      `- ${CONFIG_LABELS.others.veoEnabled}: ${formatBooleanSetting(
        config.veo.enabled
      )}`
    );
    lines.push(
      `- ${CONFIG_LABELS.others.veoModel}: ${safeConfigValue(config.veo.model)}`
    );
  }

  return lines.join('\n') + '\n';
}

export function formatSafeConfigInfo(): string {
  let configInfo = `\n⚙️ **設定情報**\n`;

  configInfo += formatBasicFeatures();
  configInfo += formatGameFeatures();
  configInfo += formatPostSettings();
  configInfo += formatAIFeatures();
  configInfo += formatEarthquakeSettings();
  configInfo += formatPressureSettings();
  configInfo += formatOtherSettings();

  return configInfo;
}
