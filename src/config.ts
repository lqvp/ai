type Config = {
  configVersion?: number; // 設定ファイルバージョン
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
  timeSignalEnabled: boolean;
  serverMonitoring: boolean;
  checkEmojisEnabled?: boolean;
  checkEmojisAtOnce?: boolean;
  gemini?: {
    enabled?: boolean;
    apiKey?: string;
    model?: string;
    thinkingBudget?: number; // -1: dynamic, 0: disabled, 128-32768: fixed budget
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
    };
    chat?: {
      enabled?: boolean;
      prompt?: string;
      groundingWithGoogleSearch?: boolean;
      enableMemory?: boolean;
      enablePersonalization?: boolean;
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
  info?: {
    eventLoopMonitoringInterval?: number;
    enableGCMonitoring?: boolean;
    precision?: number;
  };
};

import { performStartupConfigCheck } from './config-updater.js';

// 起動時設定チェックと自動更新を実行
export const config = performStartupConfigCheck();

config.wsUrl = config.host.replace('http', 'ws');
config.apiUrl = config.host + '/api';

export default config as Config;
