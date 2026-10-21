import os from 'os';
import type { default as AI } from '@/ai.js';
import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import type Message from '@/message.js';
import Module from '@/module.js';
import {
  formatDate,
  formatMemoryUsage,
  formatSafeConfigInfo,
  formatUptime,
} from './format.js';
import {
  getGcStats,
  getVersion,
  initializeVersion,
  setupGCMonitoring,
} from './gc.js';

const DEFAULT_CONFIG = {
  eventLoopMonitoringInterval: 1000,
  enableGCMonitoring: true,
  precision: 2,
};

let eventLoopDelay = 0;
let dbStats: { collections: number; documents: number; size: number } = {
  collections: 0,
  documents: 0,
  size: 0,
};

/**
 * データベース統計を非同期で更新します。
 */
async function updateDatabaseStats(ai: AI): Promise<void> {
  try {
    const stats = ai.getDatabaseStats();
    dbStats = stats;
  } catch (error) {
    console.error(
      'Failed to update database stats:',
      error instanceof Error ? error.message : String(error)
    );
    dbStats = { collections: 0, documents: 0, size: 0 }; // エラー時はリセット
  }
}

// フォーマット関数
export default class InfoModule extends Module {
  public readonly name = 'info';
  private startTime = Date.now();
  private eventLoopMeasureInterval: ReturnType<typeof setInterval> | null =
    null;
  private restoreGC: (() => void) | null = null;

  @bindThis
  public install() {
    // import 時ではなく有効化時に初期化する
    initializeVersion();
    this.restoreGC = setupGCMonitoring(config.info?.enableGCMonitoring ?? true);
    this.startEventLoopMonitoring();
    return { mentionHook: this.mentionHook };
  }

  @bindThis
  public uninstall() {
    this.stopEventLoopMonitoring();
    this.restoreGC?.();
    this.restoreGC = null;
  }

  protected onDispose(): void {
    this.uninstall();
  }

  private startEventLoopMonitoring() {
    if (this.eventLoopMeasureInterval) return;
    const interval =
      config.info?.eventLoopMonitoringInterval ??
      DEFAULT_CONFIG.eventLoopMonitoringInterval;
    let last = process.hrtime();
    this.eventLoopMeasureInterval = setInterval(() => {
      const start = process.hrtime();
      const diff = process.hrtime(last);
      const diffInMs = diff[0] * 1000 + diff[1] / 1e6;
      eventLoopDelay = Math.max(0, diffInMs - interval);
      last = start;
    }, interval);
  }

  private stopEventLoopMonitoring() {
    if (this.eventLoopMeasureInterval) {
      clearInterval(this.eventLoopMeasureInterval);
      this.eventLoopMeasureInterval = null;
    }
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (!msg.includes(['info'])) return false;

    try {
      await updateDatabaseStats(this.ai);

      const isMaster =
        msg.user.username === config.master && msg.user.host === null;
      let response = `ℹ️ バージョン: ${getVersion()}\n`;

      if (isMaster) {
        response += this.formatMasterReply();
      } else {
        response += `\n⚠️ 詳細情報を表示する権限がありません`;
      }

      msg.reply(response);
      return { reaction: '💾' };
    } catch (error) {
      console.error(
        'Error in info mentionHook:',
        error instanceof Error ? error.message : String(error)
      );
      msg.reply('⚠️ 情報の取得中にエラーが発生しました。');
      return { reaction: '❌' };
    }
  }

  private formatMasterReply(): string {
    const uptime = (Date.now() - this.startTime) / 1000;
    const mem = process.memoryUsage();
    const precision = config.info?.precision ?? DEFAULT_CONFIG.precision;

    const loadedModules = [...this.ai.modules].sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    let reply = `\n🖥️ **システム情報**\n`;
    reply += `- ホスト: ${config.host}\n`;
    reply += `- サーバー名: ${config.serverName || '未設定'}\n`;
    reply += `- 稼働時間: ${formatUptime(uptime)}\n`;
    reply += `- 起動時刻: ${formatDate(new Date(this.startTime))}\n`;

    reply += `\n⚡ **パフォーマンス**\n`;
    reply += `- イベントループ遅延: ${eventLoopDelay.toFixed(precision)}ms\n`;
    const interval =
      config.info?.eventLoopMonitoringInterval ??
      DEFAULT_CONFIG.eventLoopMonitoringInterval;
    const usage = Math.min(100, (eventLoopDelay / interval) * 100).toFixed(1);
    reply += `- イベントループ使用率: ${usage}%\n`;

    if (config.info?.enableGCMonitoring && global.gc) {
      reply += `\n🗑️ **ガベージコレクション**\n`;
      reply += `- 総実行回数: ${getGcStats().totalGCCount.toLocaleString()}\n`;
      reply += `- 総実行時間: ${getGcStats().totalGCTime.toFixed(precision)}ms\n`;
      reply += `- 最終実行: ${
        getGcStats().lastGCType
      } (${getGcStats().lastGCDuration.toFixed(precision)}ms)\n`;
    }

    reply += `\n🧠 **メモリ使用量**\n`;
    reply += `- RSS: ${formatMemoryUsage(mem.rss)}\n`;
    reply += `- ヒープ使用量: ${formatMemoryUsage(
      mem.heapUsed
    )} / ${formatMemoryUsage(mem.heapTotal)}\n`;
    reply += `- 外部メモリ: ${formatMemoryUsage(mem.external)}\n`;
    reply += `- ヒープ使用率: ${((mem.heapUsed / mem.heapTotal) * 100).toFixed(
      1
    )}%\n`;

    reply += `\n💾 **データベース**\n`;
    reply += `- コレクション数: ${dbStats.collections.toLocaleString()}\n`;
    reply += `- ドキュメント数: ${dbStats.documents.toLocaleString()}\n`;
    reply += `- データサイズ: ${formatMemoryUsage(dbStats.size)} (概算)\n`;

    reply += `\n📦 **ロード済みモジュール (${loadedModules.length})**\n`;
    reply += loadedModules.map((module) => `- ${module.name}`).join('\n');
    reply += '\n';

    reply += `\n💻 **システムリソース**\n`;
    reply += `- OS: ${os.type()} ${os.release()} (${os.arch()})\n`;
    const cpus = os.cpus();
    if (cpus.length > 0) {
      reply += `- CPU: ${cpus[0].model} (${cpus.length}コア)\n`;
    }
    reply += `- メモリ: ${formatMemoryUsage(
      os.totalmem() - os.freemem()
    )} / ${formatMemoryUsage(os.totalmem())}\n`;

    // 設定情報を追加
    reply += formatSafeConfigInfo();

    reply += `\n💡 このメッセージはマスターユーザーのみに表示されています`;

    return reply;
  }
}
