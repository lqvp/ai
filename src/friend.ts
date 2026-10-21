import 藍 from '@/ai.js';
import { bindThis } from '@/decorators.js';
import type { User } from '@/misskey/user.js';
import IModule from '@/module.js';
import getDate from '@/utils/get-date.js';
import { genItem } from '@/vocabulary.js';

export type FriendDoc = {
  userId: string;
  user: User;
  name?: string | null;
  love?: number;
  lastLoveIncrementedAt?: string;
  todayLoveIncrements?: number;
  perModulesData?: any;
  married?: boolean;
  transferCode?: string;
  reversiStrength?: number | null;
};

export default class Friend {
  private ai: 藍;

  public get userId() {
    return this.doc.userId;
  }

  public get name() {
    return this.doc.name;
  }

  public get love() {
    return this.doc.love || 0;
  }

  public get married() {
    return this.doc.married;
  }

  public doc: FriendDoc;

  constructor(ai: 藍, opts: { user?: User; doc?: FriendDoc }) {
    this.ai = ai;

    if (opts.user) {
      this.doc = this.ai.repos.friends.upsert(opts.user);
    } else if (opts.doc) {
      this.doc = opts.doc;
    } else {
      throw new Error('No friend info specified');
    }
  }

  @bindThis
  public updateUser(user: Partial<User>) {
    this.doc.user = {
      ...this.doc.user,
      ...user,
    };
    this.save();
  }

  @bindThis
  public getPerModulesData(module: IModule) {
    if (this.doc.perModulesData == null) {
      this.doc.perModulesData = {};
      this.doc.perModulesData[module.name] = {};
      this.save();
    } else if (this.doc.perModulesData[module.name] == null) {
      this.doc.perModulesData[module.name] = {};
      this.save();
    }

    return this.doc.perModulesData[module.name];
  }

  @bindThis
  public setPerModulesData(module: IModule, data: any) {
    if (this.doc.perModulesData == null) {
      this.doc.perModulesData = {};
    }

    this.doc.perModulesData[module.name] = data;

    this.save();
  }

  @bindThis
  public incLove(amount = 1) {
    const today = getDate();

    if (this.doc.lastLoveIncrementedAt != today) {
      this.doc.todayLoveIncrements = 0;
    }

    // 1日に上げられる親愛度は最大3
    if (
      this.doc.lastLoveIncrementedAt == today &&
      (this.doc.todayLoveIncrements || 0) >= 3
    )
      return;

    if (this.doc.love == null) this.doc.love = 0;
    this.doc.love += amount;

    // 最大 100
    if (this.doc.love > 100) this.doc.love = 100;

    this.doc.lastLoveIncrementedAt = today;
    this.doc.todayLoveIncrements = (this.doc.todayLoveIncrements || 0) + amount;
    this.save();

    this.ai.log(`💗 ${this.userId} +${amount}`);
  }

  @bindThis
  public decLove(amount = 1) {
    // 親愛度MAXなら下げない
    if (this.doc.love === 100) return;

    if (this.doc.love == null) this.doc.love = 0;
    this.doc.love -= amount;

    // 最低 -30
    if (this.doc.love < -30) this.doc.love = -30;

    // 親愛度マイナスなら名前を忘れる
    if (this.doc.love < 0) {
      this.doc.name = null;
    }

    this.save();

    this.ai.log(`💢 ${this.userId} -${amount}`);
  }

  @bindThis
  public async forceSetLove(amount: number): Promise<void> {
    this.doc.love = amount;

    // 最大 100 に切り詰める（必要な場合）
    if (this.doc.love > 100) this.doc.love = 100;

    // 最低 -30 に切り詰める（必要な場合）
    if (this.doc.love < -30) this.doc.love = -30;

    await this.save(); // awaitを追加

    this.ai.log(`💗 ${this.userId} (forced) set to ${amount}`);
  }

  @bindThis
  public updateName(name: string) {
    this.doc.name = name;
    this.save();
  }

  @bindThis
  public updateReversiStrength(strength: number | null) {
    if (strength == null) {
      this.doc.reversiStrength = null;
      this.save();
      return;
    }

    if (strength < 0) strength = 0;
    if (strength > 5) strength = 5;
    this.doc.reversiStrength = strength;
    this.save();
  }

  @bindThis
  public save() {
    this.ai.repos.friends.save(this.doc);
  }

  @bindThis
  public generateTransferCode(): string {
    const code = genItem();

    this.doc.transferCode = code;
    this.save();

    return code;
  }

  @bindThis
  public transferMemory(code: string): boolean {
    const src = this.ai.repos.friends.findByTransferCode(code);

    if (src == null) return false;

    this.doc.name = src.name;
    this.doc.love = src.love;
    this.doc.married = src.married;
    this.doc.perModulesData = src.perModulesData;
    this.save();

    // TODO: 合言葉を忘れる

    return true;
  }
}
