import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import type { SharedConnection } from '@/stream.js';

/** serverStats チャンネルから届く統計情報（バージョン差を吸収するため両方のキーを許容） */
type ServerStats = {
  cpu_usage?: number;
  cpu?: number;
};

export default class extends Module {
  public readonly name = 'server';

  private connection?: SharedConnection;
  private recentStat: ServerStats | undefined;
  private warned = false;
  private lastWarnedAt!: number;

  /**
   * 1秒毎のログ1分間分
   */
  private statsLogs: (ServerStats | undefined)[] = [];

  @bindThis
  public install() {
    if (!config.serverMonitoring) return false;

    this.connection = this.ai.connection.useSharedConnection('serverStats');
    this.connection.on('stats', this.onStats);

    this.every(1000, () => {
      this.statsLogs.unshift(this.recentStat);
      if (this.statsLogs.length > 60) this.statsLogs.pop();
    });

    this.every(3000, () => {
      this.check();
    });

    return {};
  }

  protected onDispose(): void {
    this.connection?.dispose?.();
    this.connection = undefined;
  }

  @bindThis
  private check() {
    const average = (arr: number[]) => arr.reduce((a, b) => a + b) / arr.length;

    const cpuPercentages = this.statsLogs.map(
      (s) => (s && (s.cpu_usage || s.cpu || 0) * 100) || 0
    );
    const cpuPercentage = average(cpuPercentages);
    if (cpuPercentage >= 70) {
      this.warn();
    } else if (cpuPercentage <= 30) {
      this.warned = false;
    }
  }

  @bindThis
  private async onStats(stats: ServerStats) {
    this.recentStat = stats;
  }

  @bindThis
  private warn() {
    //#region 前に警告したときから一旦落ち着いた状態を経験していなければ警告しない
    // 常に負荷が高いようなサーバーで無限に警告し続けるのを防ぐため
    if (this.warned) return;
    //#endregion

    //#region 前の警告から1時間経っていない場合は警告しない
    const now = Date.now();

    if (this.lastWarnedAt != null) {
      if (now - this.lastWarnedAt < 1000 * 60 * 60) return;
    }

    this.lastWarnedAt = now;
    //#endregion

    this.ai.post({
      text: serifs.server.cpu,
    });

    this.warned = true;
  }
}
