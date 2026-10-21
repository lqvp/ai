import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import {
  daysLeftInYear,
  formatJapaneseDate,
  isLeapYear,
  msUntilNextHour,
  todayKey,
} from '@/services/clock.js';

export default class extends Module {
  public readonly name = 'time-signal';

  @bindThis
  public install(): false | {} {
    if (config.timeSignalEnabled === false) return false;

    this.scheduleNextPost();

    return {};
  }

  private scheduleNextPost(): void {
    const delay = msUntilNextHour(0);
    this.later(delay, () => {
      this.post();
      this.scheduleNextPost();
    });
    this.log(`Next time signal in ${Math.round(delay / 1000)}s`);
  }

  @bindThis
  private async post(): Promise<void> {
    const today = formatJapaneseDate();
    const year = Number.parseInt(todayKey().slice(0, 4), 10);
    const baseDays = isLeapYear(year) ? 366 : 365;
    const leftDays = daysLeftInYear();
    const percentage = Math.round((leftDays / baseDays) * 1000) / 10;

    this.log('Posting...');
    await this.ai.post({
      text: serifs.timeSignal.changeDate(today, leftDays, percentage),
    });
  }
}
