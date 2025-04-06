import { bindThis } from "@/decorators.js";
import Module from "@/module.js";
import WebSocket from "ws";
import config from "@/config.js";

// Wolfx APIからの地震データの型定義
interface WolfxEarthquakeData {
	type: string;
	Title: string;
	CodeType: string;
	Issue: {
		Source: string;
		Status: string;
	};
	EventID: string;
	Serial: number;
	AnnouncedTime: string;
	OriginTime: string;
	Hypocenter: string;
	Latitude: number;
	Longitude: number;
	Magunitude: number;
	Depth: number;
	MaxIntensity: string;
	Accuracy: {
		Epicenter: string;
		Depth: string;
		Magnitude: string;
	};
	MaxIntChange?: {
		String: string;
		Reason: string;
	};
	WarnArea?: {
		Chiiki: string;
		Shindo1: string;
		Shindo2: string;
		Time: string;
		Type: string;
		Arrive: boolean;
	}[];
	isSea: boolean;
	isTraining: boolean;
	isAssumption: boolean;
	isWarn: boolean;
	isFinal: boolean;
	isCancel: boolean;
	OriginalText: string;
}

// WebSocketからのハートビートデータの型定義
interface HeartbeatData {
	type: string;
	ver: string;
	id: string;
	timestamp: number;
}

// 地震イベントを追跡するための型定義
interface EarthquakeEvent {
	eventId: string;
	initialPostId: string;
	lastUpdate: number;
	reportCount: number;
	isFinal: boolean;
	isCancel: boolean;
}

export default class extends Module {
	public readonly name = "earthquake_warning";

	private readonly WEBSOCKET_URL = "wss://ws-api.wolfx.jp/jma_eew";
	// private readonly WEBSOCKET_URL = "ws://localhost:8765/"; // ローカルでのテスト用
	private ws: WebSocket | null = null;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 10;
	private reconnectDelay = 5000; // ms
	private heartbeatInterval: NodeJS.Timeout | null = null;
	private lastHeartbeat = 0;
	private activeEvents: Map<string, EarthquakeEvent> = new Map();
	private lastEarthquakeData: Map<string, WolfxEarthquakeData> = new Map();

	@bindThis
	public install() {
		this.log("地震警報モジュールを初期化しています...");
		this.connectWebSocket();
		return {};
	}

	@bindThis
	private connectWebSocket(): void {
		try {
			this.log("WebSocketに接続しています...");
			this.ws = new WebSocket(this.WEBSOCKET_URL);

			this.ws.on("open", this.onWebSocketOpen);
			this.ws.on("message", this.onWebSocketMessage);
			this.ws.on("error", this.onWebSocketError);
			this.ws.on("close", this.onWebSocketClose);

			// ハートビートチェック開始
			this.startHeartbeatCheck();
		} catch (error) {
			this.log(`WebSocket接続エラー: ${error}`);
			this.scheduleReconnect();
		}
	}

	@bindThis
	private onWebSocketOpen(): void {
		this.log("WebSocket接続が確立されました");
		this.reconnectAttempts = 0;

		// 接続後に現在の情報をリクエスト
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send("query_jmaeew");
		}
	}

	@bindThis
	private onWebSocketMessage(data: WebSocket.Data): void {
		try {
			const message = JSON.parse(data.toString());

			// ハートビートメッセージの処理
			if (message.type === "heartbeat") {
				this.handleHeartbeat(message);
				return;
			}

			// 地震情報の処理
			if (message.type === "jma_eew") {
				this.handleEarthquakeData(message);
			}
		} catch (error) {
			this.log(`メッセージ処理エラー: ${error}`);
		}
	}

	@bindThis
	private onWebSocketError(error: Error): void {
		this.log(`WebSocketエラー: ${error.message}`);
	}

	@bindThis
	private onWebSocketClose(code: number, reason: string): void {
		this.log(`WebSocket接続が閉じられました: ${code} ${reason}`);
		this.stopHeartbeatCheck();
		this.scheduleReconnect();
	}

	@bindThis
	private scheduleReconnect(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			this.log("最大再接続試行回数を超えました。再接続を停止します。");
			return;
		}

		this.reconnectAttempts++;
		const delay =
			this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);

		this.log(
			`${delay}ms後に再接続を試みます (試行: ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
		);

		setTimeout(() => {
			this.connectWebSocket();
		}, delay);
	}

	@bindThis
	private handleHeartbeat(data: HeartbeatData): void {
		this.lastHeartbeat = Date.now();

		// ハートビートに応答
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send("ping");
		}
	}

	@bindThis
	private startHeartbeatCheck(): void {
		this.lastHeartbeat = Date.now();
		this.heartbeatInterval = setInterval(() => {
			const now = Date.now();
			// 2分以上ハートビートがない場合は再接続
			if (now - this.lastHeartbeat > 120000) {
				this.log("ハートビートのタイムアウト。再接続します。");
				this.closeConnection();
				this.connectWebSocket();
			}
		}, 60000);
	}

	@bindThis
	private stopHeartbeatCheck(): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}
	}

	@bindThis
	private closeConnection(): void {
		if (this.ws) {
			try {
				this.ws.terminate();
			} catch (error) {
				this.log(`接続終了エラー: ${error}`);
			} finally {
				this.ws = null;
			}
		}
	}

	@bindThis
	private handleEarthquakeData(data: WolfxEarthquakeData): void {
		// トレーニングデータは無視
		if (data.isTraining) {
			this.log("トレーニングデータを受信しました（処理をスキップ）");
			return;
		}

		const eventId = data.EventID;
		const existingEvent = this.activeEvents.get(eventId);

		// イベントの処理
		if (!existingEvent) {
			// 新しい地震イベント
			if (!this.shouldReportEarthquake(data)) {
				this.log(
					`報告基準を満たさない地震を検出: ${data.Hypocenter} M${data.Magunitude}`
				);
				return;
			}

			this.processNewEarthquake(data);
		} else if (data.isCancel && !existingEvent.isCancel) {
			// キャンセル情報
			this.processCancellation(data, existingEvent);
		} else if (data.isFinal && !existingEvent.isFinal) {
			// 最終報
			this.processFinalReport(data, existingEvent);
		} else {
			// 続報
			this.processUpdateReport(data, existingEvent);
		}
	}

	@bindThis
	private shouldReportEarthquake(data: WolfxEarthquakeData): boolean {
		// 震度の数値変換
		const intensityValue = this.convertIntensityToNumber(data.MaxIntensity);

		// 震度条件の確認
		const minIntensityThreshold =
			config.earthquakeWarning?.minIntensityThreshold ?? 3;
		if (intensityValue < minIntensityThreshold) {
			return false; // 最小震度未満は無視
		}

		const minMagunitudeForWeak =
			config.earthquakeWarning?.minMagunitudeForWeak ?? 4.0;
		if (intensityValue < 4 && data.Magunitude < minMagunitudeForWeak) {
			return false; // 震度4未満かつマグニチュード基準未満は無視
		}

		return true;
	}

	@bindThis
	private async processNewEarthquake(data: WolfxEarthquakeData): Promise<void> {
		// 初回メッセージ生成
		const message = this.generateEarthquakeMessage(data, true);

		try {
			// 投稿を行い、結果を取得
			const post = await this.ai.post({
				text: message,
			});

			// イベント情報を保存
			this.activeEvents.set(data.EventID, {
				eventId: data.EventID,
				initialPostId: post.id,
				lastUpdate: Date.now(),
				reportCount: 1,
				isFinal: data.isFinal,
				isCancel: data.isCancel,
			});

			this.log(
				`新しい地震速報を送信しました: ${data.Hypocenter} M${data.Magunitude}`
			);
		} catch (error) {
			this.log(`メッセージ送信エラー: ${error}`);
		}
	}

	@bindThis
	private async processUpdateReport(
		data: WolfxEarthquakeData,
		existingEvent: EarthquakeEvent
	): Promise<void> {
		// 報告回数をインクリメント
		const reportNumber = existingEvent.reportCount + 1;

		// 続報メッセージ生成
		let message = `【続報 #${reportNumber}】\n`;
		message += this.generateEarthquakeMessage(data, false);

		try {
			// 返信として投稿
			const post = await this.ai.post({
				text: message,
				replyId: existingEvent.initialPostId,
			});

			// イベント情報を更新
			this.activeEvents.set(data.EventID, {
				...existingEvent,
				lastUpdate: Date.now(),
				reportCount: reportNumber,
			});

			this.log(
				`地震速報の続報を送信しました: ${data.Hypocenter} M${data.Magunitude}`
			);
		} catch (error) {
			this.log(`続報送信エラー: ${error}`);
		}
	}

	@bindThis
	private async processCancellation(
		data: WolfxEarthquakeData,
		existingEvent: EarthquakeEvent
	): Promise<void> {
		const message = `さっきの地震速報は取り消されました。実際の揺れはなかったようです。`;

		try {
			await this.ai.post({
				text: message,
				replyId: existingEvent.initialPostId,
			});

			// イベント情報を更新
			this.activeEvents.set(data.EventID, {
				...existingEvent,
				isCancel: true,
				lastUpdate: Date.now(),
			});

			this.log(`地震速報のキャンセルを送信しました: ${data.EventID}`);

			// 一定時間後にイベント情報をクリーンアップ
			setTimeout(() => {
				this.activeEvents.delete(data.EventID);
			}, 3600000); // 1時間後
		} catch (error) {
			this.log(`キャンセル送信エラー: ${error}`);
		}
	}

	@bindThis
	private async processFinalReport(
		data: WolfxEarthquakeData,
		existingEvent: EarthquakeEvent
	): Promise<void> {
		const message = `【最終報】\n${this.generateEarthquakeMessage(
			data,
			false
		)}`;

		try {
			await this.ai.post({
				text: message,
				replyId: existingEvent.initialPostId,
			});

			// イベント情報を更新
			this.activeEvents.set(data.EventID, {
				...existingEvent,
				isFinal: true,
				lastUpdate: Date.now(),
			});

			this.log(`地震速報の最終報を送信しました: ${data.EventID}`);

			// 一定時間後にイベント情報をクリーンアップ
			setTimeout(() => {
				this.activeEvents.delete(data.EventID);
			}, 3600000); // 1時間後
		} catch (error) {
			this.log(`最終報送信エラー: ${error}`);
		}
	}

	@bindThis
	private generateEarthquakeMessage(
		data: WolfxEarthquakeData,
		isInitial: boolean
	): string {
		let message = "";
		const intensityValue = this.convertIntensityToNumber(data.MaxIntensity);

		// 初回メッセージの場合のみ、震度に応じた反応を追加
		if (isInitial) {
			if (intensityValue < 4) {
				message += this.randomChoice([
					"ゆれ……",
					"ゆれ?",
					"地震ですかね？",
					"揺れそうな気がします！",
					"ゆ……？",
					"ゆ？",
					"ぽよん！",
					":blobbounce:",
				]);
			} else if (intensityValue === 4) {
				message += this.randomChoice([
					"ゆれ……！",
					"地震です！！",
					"結構揺れます！",
				]);
			} else if (intensityValue === 5) {
				message += this.randomChoice([
					"ゆれます……！　おおきいです！！",
					"かなり揺れます！",
				]);
			} else if (intensityValue === 6) {
				message += this.randomChoice([
					"大地震です！！",
					"めちゃくちゃ揺れます！",
				]);
			} else if (intensityValue >= 7) {
				message += this.randomChoice(["！！　大地震です！！"]);
			}

			message += "\n\n";
		}

		const announcedTime = this.formatJSTDateTime(new Date(data.AnnouncedTime));
		message += `${announcedTime}、地震速報を受信しました！\n`;
		message += `${data.Hypocenter}付近で震度${this.convertIntensityDisplay(
			data.MaxIntensity
		)}の揺れが予想されます！\n`;
		message += `マグニチュードは${data.Magunitude}、震源の深さは約${data.Depth}kmです。\n`;

		// 警報の場合は特別な表示
		if (data.isWarn) {
			message += `\n⚠️ これは警報です！強い揺れに注意してください ⚠️\n`;
		}

		// 震源精度情報がある場合
		if (data.Accuracy) {
			const accuracyInfo: string[] = [];
			if (data.Accuracy.Epicenter && data.Accuracy.Epicenter !== "不明") {
				accuracyInfo.push(`震源: ${data.Accuracy.Epicenter}`);
			}
			if (data.Accuracy.Magnitude && data.Accuracy.Magnitude !== "不明") {
				accuracyInfo.push(`M: ${data.Accuracy.Magnitude}`);
			}
			if (data.Accuracy.Depth && data.Accuracy.Depth !== "不明") {
				accuracyInfo.push(`深さ: ${data.Accuracy.Depth}`);
			}

			if (accuracyInfo.length > 0) {
				message += `\n精度情報: ${accuracyInfo.join("、")}\n`;
			}
		}

		// 震度変更情報がある場合
		if (data.MaxIntChange && data.MaxIntChange.String) {
			// 震度表示を変換
			const convertedString = data.MaxIntChange.String.replace(
				"震度5-",
				"震度5弱"
			)
				.replace("震度5+", "震度5強")
				.replace("震度6-", "震度6弱")
				.replace("震度6+", "震度6強");

			message += `\n震度情報が変更されました: ${convertedString}\n`;
			if (data.MaxIntChange.Reason) {
				message += `変更理由: ${data.MaxIntChange.Reason}\n`;
			}
		}

		// 更新情報の追加（初回以外で表示）
		if (!isInitial && this.lastEarthquakeData.has(data.EventID)) {
			const lastData = this.lastEarthquakeData.get(data.EventID);
			if (lastData) {
				const updates: string[] = [];

				// マグニチュードの変化
				if (lastData.Magunitude !== data.Magunitude) {
					const diff = data.Magunitude - lastData.Magunitude;
					const direction = diff > 0 ? "上方" : "下方";
					updates.push(
						`マグニチュード: ${lastData.Magunitude} → ${data.Magunitude} (${direction}修正)`
					);
				}

				// 震源の深さの変化
				if (lastData.Depth !== data.Depth) {
					const diff = data.Depth - lastData.Depth;
					updates.push(
						`震源の深さ: ${lastData.Depth}km → ${data.Depth}km (${
							diff > 0 ? "深く" : "浅く"
						}修正)`
					);
				}

				// 震度の変化（MaxIntChangeとは別に、単純な前回との比較）
				if (lastData.MaxIntensity !== data.MaxIntensity) {
					updates.push(
						`震度: ${this.convertIntensityDisplay(
							lastData.MaxIntensity
						)} → ${this.convertIntensityDisplay(data.MaxIntensity)}`
					);
				}

				if (updates.length > 0) {
					message += "\n📊 前回からの更新情報:\n";
					updates.forEach((update) => {
						message += `・${update}\n`;
					});
				}
			}
		}

		// 警戒地域情報がある場合
		if (data.WarnArea && data.WarnArea.length > 0) {
			message += `\n警戒地域:\n`;
			for (let i = 0; i < Math.min(data.WarnArea.length, 5); i++) {
				// 最大5地域まで表示
				const area = data.WarnArea[i];
				message += `- ${area.Chiiki}: 震度${this.convertIntensityDisplay(
					area.Shindo1
				)}～${this.convertIntensityDisplay(area.Shindo2)} (${area.Type})\n`;
			}
			if (data.WarnArea.length > 5) {
				message += `他${data.WarnArea.length - 5}地域...\n`;
			}
		}

		// データを保存して次回の比較に使用
		this.lastEarthquakeData.set(data.EventID, { ...data });

		return message;
	}

	// ユーティリティ関数
	@bindThis
	private convertIntensityToNumber(intensity: string): number {
		// 震度文字列を数値に変換 (互換性を保持しつつ処理)
		if (intensity.includes("7")) return 7;
		if (intensity.includes("6+") || intensity.includes("6強")) return 6;
		if (intensity.includes("6-") || intensity.includes("6弱")) return 6;
		if (intensity.includes("5+") || intensity.includes("5強")) return 5;
		if (intensity.includes("5-") || intensity.includes("5弱")) return 5;
		if (intensity.includes("4")) return 4;
		if (intensity.includes("3")) return 3;
		if (intensity.includes("2")) return 2;
		if (intensity.includes("1")) return 1;
		return 0;
	}

	@bindThis
	private convertIntensityDisplay(intensity: string): string {
		// -/+ を 弱/強 に変換して表示する (元のデータは変更しない)
		return intensity
			.replace("5-", "5弱")
			.replace("5+", "5強")
			.replace("6-", "6弱")
			.replace("6+", "6強");
	}

	@bindThis
	private formatJSTDateTime(date: Date): string {
		return (
			date.toLocaleString("ja-JP", {
				timeZone: "Asia/Tokyo",
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hour12: false,
			}) + " JST"
		);
	}

	@bindThis
	private randomChoice(a: Array<string>): string {
		const r = Math.floor(Math.random() * a.length);
		return a[r];
	}
}
