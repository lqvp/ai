export type InfoFeatureFlags = {
  keywordSearch: boolean;
  reversi: boolean;
  autoWord: boolean;
  chart: boolean;
  timeSignal: boolean;
  serverMonitoring: boolean;
  emojiCheck: boolean;
  maze: boolean;
  poll: boolean;
};

export type FeatureFlagsConfig = {
  keywordEnabled?: boolean;
  reversiEnabled?: boolean;
  notingEnabled?: boolean;
  chartEnabled?: boolean;
  timeSignalEnabled?: boolean;
  serverMonitoring?: boolean;
  checkEmojisEnabled?: boolean;
  mazeEnable?: boolean;
  pollEnable?: boolean;
};

function isEnabledByDefaultUnlessFalse(value: boolean | undefined): boolean {
  return value !== false;
}

export function resolveInfoFeatureFlags(cfg: FeatureFlagsConfig): InfoFeatureFlags {
  return {
    keywordSearch: cfg.keywordEnabled === true,
    reversi: cfg.reversiEnabled === true,
    autoWord: isEnabledByDefaultUnlessFalse(cfg.notingEnabled),
    chart: isEnabledByDefaultUnlessFalse(cfg.chartEnabled),
    timeSignal: isEnabledByDefaultUnlessFalse(cfg.timeSignalEnabled),
    serverMonitoring: cfg.serverMonitoring === true,
    emojiCheck: cfg.checkEmojisEnabled === true,
    maze: cfg.mazeEnable === true,
    poll: cfg.pollEnable === true,
  };
}
