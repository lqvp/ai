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
	prompt?: string;
	autoNotePrompt?: string;
	autoNoteIntervalMinutes?: string;
	geminiAutoNoteProbability?: string;
	aichatRandomTalkEnabled?: boolean;
	aichatRandomTalkProbability?: string;
	aichatRandomTalkIntervalMinutes?: string;
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
		requestTimeoutMs?: number;
		maxErrorRetries?: number;
		errorCooldownMs?: number;
		minIntensityThreshold?: number;
		minMagunitudeForWeak?: number;
		maxReportHistory?: number;
		checkIntervalMs?: number;
		websocketReconnectMaxAttempts?: number;
		websocketReconnectDelay?: number;
		heartbeatTimeoutMs?: number;
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
};

import { readFile } from "fs/promises";
const config = JSON.parse(
	await readFile(new URL("../config.json", import.meta.url), "utf8")
);

if (!config.aiName) config.aiName = ["藍", "三須木"];
if (!config.followAllowedHosts) config.followAllowedHosts = [];
if (!config.followExcludeInstances) config.followExcludeInstances = [];
if (!config.mazeEnable) config.mazeEnable = false;
if (!config.pollEnable) config.pollEnable = false;
if (!config.defaultVisibility) config.defaultVisibility = "public";
if (config.postNotPublic === undefined) config.postNotPublic = false;

// 地震速報の設定デフォルト値
if (!config.earthquakeWarning) config.earthquakeWarning = {};
if (config.earthquakeWarning.requestTimeoutMs === undefined)
	config.earthquakeWarning.requestTimeoutMs = 10000;
if (config.earthquakeWarning.maxErrorRetries === undefined)
	config.earthquakeWarning.maxErrorRetries = 5;
if (config.earthquakeWarning.errorCooldownMs === undefined)
	config.earthquakeWarning.errorCooldownMs = 60000;
if (config.earthquakeWarning.minIntensityThreshold === undefined)
	config.earthquakeWarning.minIntensityThreshold = 3;
if (config.earthquakeWarning.minMagunitudeForWeak === undefined)
	config.earthquakeWarning.minMagunitudeForWeak = 4.0;
if (config.earthquakeWarning.maxReportHistory === undefined)
	config.earthquakeWarning.maxReportHistory = 100;
if (config.earthquakeWarning.checkIntervalMs === undefined)
	config.earthquakeWarning.checkIntervalMs = 1000;
// WebSocket関連の設定
if (config.earthquakeWarning.websocketReconnectMaxAttempts === undefined)
	config.earthquakeWarning.websocketReconnectMaxAttempts = 10;
if (config.earthquakeWarning.websocketReconnectDelay === undefined)
	config.earthquakeWarning.websocketReconnectDelay = 5000;
if (config.earthquakeWarning.heartbeatTimeoutMs === undefined)
	config.earthquakeWarning.heartbeatTimeoutMs = 120000;

// 気圧モジュールの設定デフォルト値
if (!config.kiatsu) config.kiatsu = {};
if (config.kiatsu.locationCode === undefined)
	config.kiatsu.locationCode = "13102"; // 東京都中央区
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

config.wsUrl = config.host.replace("http", "ws");
config.apiUrl = config.host + "/api";

export default config as Config;
