type Config = {
  host: string;
  serverName?: string;
  i: string;
  aiName?: string[];
  master?: string;
  wsUrl: string;
  apiUrl: string;
  keywordEnabled: boolean;
  reversiEnabled: boolean;
  notingEnabled: boolean;
  chartEnabled: boolean;
  serverMonitoring: boolean;
  checkEmojisEnabled?: boolean;
  checkEmojisAtOnce?: boolean;
  geminiApiKey?: string;
  geminiModel?: string;
  geminiPostMode?: string;
  imagenEnabled?: boolean;
  imagenApiKey?: string;
  prompt?: string;
  autoNotePrompt?: string;
  autoNoteIntervalMinutes?: number;
  autoNoteDisableNightPosting?: boolean;
  geminiAutoNoteProbability?: number;
  aichatRandomTalkEnabled?: boolean;
  aichatRandomTalkProbability?: number;
  aichatRandomTalkIntervalMinutes?: number;
  aichatGroundingWithGoogleSearchAlwaysEnabled?: boolean;
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
    minIntensityThreshold?: number;
    minMagunitudeForWeak?: number;
    websocketReconnectMaxAttempts?: number;
    websocketReconnectDelay?: number;
    maxReconnectDelay?: number;
    heartbeatTimeoutMs?: number;
    heartbeatIntervalMs?: number;
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
};

import { readFile } from 'fs/promises';
const config = JSON.parse(
  await readFile(new URL('../config.json', import.meta.url), 'utf8')
);

if (!config.aiName) config.aiName = ['藍', '三須木'];
if (!config.followAllowedHosts) config.followAllowedHosts = [];
if (!config.followExcludeInstances) config.followExcludeInstances = [];
if (!config.mazeEnable) config.mazeEnable = false;
if (!config.pollEnable) config.pollEnable = false;
if (!config.defaultVisibility) config.defaultVisibility = 'public';
if (config.postNotPublic === undefined) config.postNotPublic = false;
if (config.autoNoteDisableNightPosting === undefined)
  config.autoNoteDisableNightPosting = true;

// 地震速報の設定デフォルト値
if (!config.earthquakeWarning) config.earthquakeWarning = {};
if (config.earthquakeWarning.minIntensityThreshold === undefined)
  config.earthquakeWarning.minIntensityThreshold = 3;
if (config.earthquakeWarning.minMagunitudeForWeak === undefined)
  config.earthquakeWarning.minMagunitudeForWeak = 4.0;
// WebSocket関連の設定
if (config.earthquakeWarning.websocketReconnectMaxAttempts === undefined)
  config.earthquakeWarning.websocketReconnectMaxAttempts = 10;
if (config.earthquakeWarning.websocketReconnectDelay === undefined)
  config.earthquakeWarning.websocketReconnectDelay = 5000;
if (config.earthquakeWarning.maxReconnectDelay === undefined)
  config.earthquakeWarning.maxReconnectDelay = 300000;
if (config.earthquakeWarning.heartbeatTimeoutMs === undefined)
  config.earthquakeWarning.heartbeatTimeoutMs = 120000;
if (config.earthquakeWarning.heartbeatIntervalMs === undefined)
  config.earthquakeWarning.heartbeatIntervalMs = 60000;

// 気圧モジュールの設定デフォルト値
if (!config.kiatsu) config.kiatsu = {};
if (config.kiatsu.locationCode === undefined)
  config.kiatsu.locationCode = '13102'; // 東京都中央区
if (config.kiatsu.requestTimeoutMs === undefined)
  config.kiatsu.requestTimeoutMs = 10000;
if (config.kiatsu.maxErrorRetries === undefined)
  config.kiatsu.maxErrorRetries = 5;
if (config.kiatsu.updateIntervalMs === undefined)
  config.kiatsu.updateIntervalMs = 10 * 60 * 1000;
if (config.kiatsu.postIntervalMs === undefined)
  config.kiatsu.postIntervalMs = 12 * 60 * 60 * 1000;
if (config.kiatsu.errorCooldownMs === undefined)
  config.kiatsu.errorCooldownMs = 60 * 60 * 1000;
if (config.kiatsu.minPostLevel === undefined) config.kiatsu.minPostLevel = 2;

// Imagenモジュールの設定デフォルト値
if (config.imagenEnabled === undefined) config.imagenEnabled = false;
if (config.imagenApiKey === undefined) config.imagenApiKey = null;

// 天気予報自動投稿の設定デフォルト値
if (!config.weatherAutoNotePref) config.weatherAutoNotePref = '東京都';
if (!config.weatherAutoNoteHour) config.weatherAutoNoteHour = 7;

config.wsUrl = config.host.replace('http', 'ws');
config.apiUrl = config.host + '/api';

export default config as Config;
