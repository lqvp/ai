import type loki from 'lokijs';

/**
 * プロアクティブフォローアップのユーザーごとの状態。
 * 送信スロットル・無視カウント・クールダウンをここで永続化する。
 */
export type FollowupUserState = {
  userId: string;
  /** 最後にフォローアップを送った時刻。未送信なら null */
  lastFollowUpAt: number | null;
  /** 連続で無視された回数（24時間以内に反応がなかったフォローアップの数） */
  ignoredCount: number;
  /** この日時までクールダウン中。クールダウン外なら null */
  cooldownUntil: number | null;
  /** 無視判定を確定済みの lastFollowUpAt。二重カウント防止用 */
  settledFollowUpAt: number | null;
};

/**
 * `aichatFollowupState` コレクションへのアクセスをまとめる。
 * 頻度制限の判断はすべてここに集約し、proactive-followup.ts から利用する。
 */
export class FollowupStateRepository {
  constructor(
    private readonly collection: loki.Collection<FollowupUserState>
  ) {}

  private find(userId: string): FollowupUserState | null {
    return this.collection.findOne({ userId }) as FollowupUserState | null;
  }

  /** 全ユーザーの状態を取得する（無視判定の一括処理用）。 */
  public findAll(): FollowupUserState[] {
    return this.collection.find({}) as FollowupUserState[];
  }

  /** 未登録ユーザーの初期状態を作って返す（DBには保存しない）。 */
  private createDefault(userId: string): FollowupUserState {
    return {
      userId,
      lastFollowUpAt: null,
      ignoredCount: 0,
      cooldownUntil: null,
      settledFollowUpAt: null,
    };
  }

  /**
   * フォローアップを送れるか（スロットル・クールダウン判定）。
   * 未登録ユーザーは常に送れる。マスターの免除は呼び出し側で行う。
   */
  public canSend(userId: string, throttleMs: number, now: number): boolean {
    const state = this.find(userId);
    if (state == null) return true;
    if (state.cooldownUntil != null && now < state.cooldownUntil) return false;
    if (state.lastFollowUpAt == null) return true;
    return now - state.lastFollowUpAt >= throttleMs;
  }

  /** フォローアップ送信を記録する（新規ユーザーはここで登録される）。 */
  public recordFollowUp(userId: string, now: number): void {
    const state = this.find(userId) ?? this.createDefault(userId);
    state.lastFollowUpAt = now;
    state.settledFollowUpAt = null;
    this.upsert(state);
  }

  /**
   * ユーザーからの反応を記録し、連続無視カウントをリセットする。
   * 反応があったのに黙り続けるのは不自然なため、カウントはここで清算する。
   */
  public markReplied(userId: string): void {
    const state = this.find(userId);
    if (state == null) return;
    state.ignoredCount = 0;
    this.upsert(state);
  }

  /**
   * 無視判定を確定する。フォローアップから ignoreWindowMs 経過しても
   * 反応がなければ ignoredCount を増やし、2回連続なら cooldownMs の
   * クールダウンに入れる。判定は各フォローアップにつき1回だけ
   * （settledFollowUpAt で二重カウントを防ぐ）。
   */
  public settleIgnored(
    userId: string,
    interactedSince: boolean,
    now: number,
    ignoreWindowMs: number,
    cooldownMs: number
  ): void {
    const state = this.find(userId);
    if (state == null || state.lastFollowUpAt == null) return;
    if (state.settledFollowUpAt === state.lastFollowUpAt) return;
    if (now - state.lastFollowUpAt < ignoreWindowMs) return;

    if (interactedSince) {
      // 反応があったのでカウントを清算するだけ
      state.ignoredCount = 0;
    } else {
      state.ignoredCount += 1;
    }
    state.settledFollowUpAt = state.lastFollowUpAt;

    if (state.ignoredCount >= 2) {
      // 2回連続で無視された相手にはしばらく距離を置く
      state.cooldownUntil = now + cooldownMs;
      state.ignoredCount = 0;
    }
    this.upsert(state);
  }

  /** upsert。insertOne 失敗時は引数をそのまま返す lokijs の仕様に合わせる。 */
  private upsert(state: FollowupUserState): void {
    const existing = this.find(state.userId);
    if (existing == null) {
      this.collection.insertOne({ ...state });
    } else {
      this.collection.update({ ...state });
    }
  }
}
