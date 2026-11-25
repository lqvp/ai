import type * as Misskey from 'misskey-js';
import type { PostParam } from '@/api/APIClient.js';
import type { Note, User } from '@/misskey/types.js';
import { acct } from '@/utils/acct.js';
import type { AffinityStore } from './affinity-store.js';
import { DEFAULTS, MINUTES_TO_MS, TIMEOUT_TIME } from './constants.js';
import type {
  AiChatHist,
  ChatHistoryRepository,
} from './history-repository.js';
import { JsonFileStore } from './json-file-store.js';
import type { PlaybookLoader } from './playbook.js';
import {
  MISSKEY_FORMAT_CONSTRAINTS,
  SAFETY_CONSTRAINTS,
} from './prompt-builder.js';
import { callStructuredJson } from './structured-llm.js';

export type ReactionFollowUpState = {
  version: 1;
  userLastFollowUpAt: Record<string, number>;
};

function normalizeFollowUpState(raw: unknown): ReactionFollowUpState {
  const obj =
    raw != null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {};
  const rawMap =
    obj.userLastFollowUpAt != null && typeof obj.userLastFollowUpAt === 'object'
      ? (obj.userLastFollowUpAt as Record<string, unknown>)
      : {};
  const userLastFollowUpAt: Record<string, number> = {};
  for (const key of Object.keys(rawMap)) {
    const value = rawMap[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      userLastFollowUpAt[key] = value;
    }
  }
  return { version: 1, userLastFollowUpAt };
}

export function createReactionFollowUpStateStore(
  filePath: string,
  options: { log?: (message: string) => void; now?: () => number } = {}
): JsonFileStore<ReactionFollowUpState> {
  return new JsonFileStore<ReactionFollowUpState>({
    filePath,
    createDefault: () => ({ version: 1, userLastFollowUpAt: {} }),
    normalize: normalizeFollowUpState,
    log: options.log,
    now: options.now,
  });
}

export type ReactionFollowUpConfig = {
  enabled?: boolean;
  minAffinity?: number;
  probability?: number;
  delaySeconds?: number;
  userCooldownMinutes?: number;
  noteMaxAgeMinutes?: number;
};

export type ReactionFollowUpDecision = {
  shouldReply: boolean;
  text: string | null;
};

export type ReactionFollowUpDeps = {
  selfUserId: string;
  history: ChatHistoryRepository;
  affinityStore: AffinityStore;
  playbookLoader: PlaybookLoader;
  isMasterUser: (user: User) => boolean;
  post: (param: PostParam) => Promise<Note>;
  subscribeReply: (
    key: string,
    isChat: boolean,
    noteId: string,
    data?: unknown
  ) => void;
  postNotPublic?: boolean;
  /** false の場合はリアクションによる好感度微増を行わない */
  affinityEnabled?: boolean;
  stateStore?: JsonFileStore<ReactionFollowUpState>;
  config?: ReactionFollowUpConfig;
  log?: (message: string) => void;
  now?: () => number;
  rng?: () => number;
  callLlm?: (
    system: string,
    user: string
  ) => Promise<ReactionFollowUpDecision | null>;
};

const RESTRICTED_VISIBILITIES = new Set(['specified', 'followers']);
const CONVERSATION_ENDER_REACTIONS = new Set(['👍', '👌', '✅', '👀', 'like']);
const FOLLOWUP_MAX_TOKENS = 256;
const FOLLOWUP_TIMEOUT_MS = 15_000;
const USER_REPLY_MARKER_TTL_MS = 60 * 60 * 1000;

export function parseReactionFollowUpDecision(
  obj: Record<string, unknown>
): ReactionFollowUpDecision {
  const shouldReply = obj.shouldReply === true;
  const text =
    shouldReply && typeof obj.text === 'string' && obj.text.trim() !== ''
      ? obj.text.trim()
      : null;
  return {
    shouldReply: shouldReply && text !== null,
    text,
  };
}

/**
 * リアクション通知を受けて好感度を微増(+1)させ、
 * 条件を満たす場合のみ遅れて自然な追いリプを検討・実行する。
 */
export class ReactionFollowUpHandler {
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly userLastFollowUpAt = new Map<string, number>();
  private readonly pendingTimers = new Set<NodeJS.Timeout>();
  private readonly userReplyMarkers = new Map<string, number>();
  private readonly followUpLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: ReactionFollowUpDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => Date.now());
    this.rng = deps.rng ?? Math.random;
  }

  public markUserReply(noteId: string, userId: string): void {
    const nowMs = this.now();
    for (const [key, ts] of this.userReplyMarkers) {
      if (nowMs - ts > USER_REPLY_MARKER_TTL_MS) {
        this.userReplyMarkers.delete(key);
      }
    }
    this.userReplyMarkers.set(`${noteId}:${userId}`, nowMs);
  }

  private hasUserReply(noteId: string, userId: string): boolean {
    return this.userReplyMarkers.has(`${noteId}:${userId}`);
  }

  public dispose(): void {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  public async handleNotification(
    notification: Misskey.entities.Notification
  ): Promise<boolean> {
    if (notification.type !== 'reaction') return false;
    const reactor = notification.user as unknown as User | undefined;
    const note = notification.note as unknown as Note | undefined;
    if (!reactor || !note) return false;
    if (reactor.id === this.deps.selfUserId || reactor.isBot) return false;
    if (RESTRICTED_VISIBILITIES.has(note.visibility)) return false;

    const isMaster = this.deps.isMasterUser(reactor);
    if (this.deps.affinityEnabled !== false) {
      try {
        await this.deps.affinityStore.applyReactionBump(
          reactor,
          note.id,
          isMaster
        );
      } catch (err: unknown) {
        // 手動編集で好感度JSONが壊れている場合でも、保存済みの
        // 最終状態を使って追いリプ判定自体は継続する。
        this.log(
          `好感度リアクション反映をスキップしました: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const cfg = this.deps.config ?? {};
    if (cfg.enabled === false) return false;
    if (note.userId !== this.deps.selfUserId) return false;

    const reaction =
      typeof notification.reaction === 'string' ? notification.reaction : '';
    if (CONVERSATION_ENDER_REACTIONS.has(reaction)) return false;

    const session = this.deps.history.findByPostId(note.id);
    if (!session || session.isChat) return false;
    if (session.latestPostId && session.latestPostId !== note.id) return false;
    if (!session.latestPostId && session.postId !== note.id) return false;
    if (session.followUpUsed) return false;
    if (session.ownerUserId && session.ownerUserId !== reactor.id) {
      return false;
    }

    const nowMs = this.now();
    const noteMaxAgeMs = (cfg.noteMaxAgeMinutes ?? 15) * MINUTES_TO_MS;
    const refTs = session.updatedAt ?? session.createdAt;
    if (nowMs - refTs > noteMaxAgeMs) return false;

    const entry = await this.deps.affinityStore.getEntry(reactor, { isMaster });
    const minAffinity = cfg.minAffinity ?? 30;
    if (!isMaster && entry.score < minAffinity) return false;

    const cooldownMs = (cfg.userCooldownMinutes ?? 360) * MINUTES_TO_MS;
    const lastFollowUp = await this.getLastFollowUpAt(reactor.id);
    if (lastFollowUp != null && nowMs - lastFollowUp < cooldownMs) {
      return false;
    }

    const probability = cfg.probability ?? 0.25;
    if (this.rng() >= probability) return false;

    const delaySeconds = cfg.delaySeconds ?? 10;
    const delayMs =
      delaySeconds <= 0
        ? 0
        : Math.max(0, Math.round((delaySeconds + (this.rng() * 4 - 2)) * 1000));

    if (delayMs === 0) {
      return this.executeFollowUp(
        session.sessionId ?? session.postId,
        note,
        reactor,
        reaction
      );
    }

    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      void this.executeFollowUp(
        session.sessionId ?? session.postId,
        note,
        reactor,
        reaction
      ).catch((err) => {
        this.log(
          `追いリプ実行エラー: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }, delayMs);
    this.pendingTimers.add(timer);
    return true;
  }

  public async executeFollowUp(
    sessionId: string,
    note: Note,
    reactor: User,
    reaction: string
  ): Promise<boolean> {
    const session =
      this.deps.history.findBySessionId(sessionId) ??
      this.deps.history.findByPostId(note.id);
    if (!session || session.isChat || session.followUpUsed) {
      return false;
    }
    const latestId = session.latestPostId ?? session.postId;
    if (latestId !== note.id || this.hasUserReply(note.id, reactor.id)) {
      // 待機中にユーザーからテキスト返信が来たため追いリプは中止
      return false;
    }

    return this.runWithFollowUpLock(reactor.id, async () => {
      const cfg = this.deps.config ?? {};
      const cooldownMs = (cfg.userCooldownMinutes ?? 360) * MINUTES_TO_MS;
      const lastFollowUp = await this.getLastFollowUpAt(reactor.id);
      if (lastFollowUp != null && this.now() - lastFollowUp < cooldownMs) {
        return false;
      }
      return this.executeFollowUpInner(
        session,
        sessionId,
        note,
        reactor,
        reaction
      );
    });
  }

  private async getLastFollowUpAt(userId: string): Promise<number | undefined> {
    if (!this.deps.stateStore) {
      return this.userLastFollowUpAt.get(userId);
    }
    const state = await this.deps.stateStore.load();
    return state.userLastFollowUpAt[userId];
  }

  private async recordFollowUpAt(userId: string, nowMs: number): Promise<void> {
    if (!this.deps.stateStore) {
      this.userLastFollowUpAt.set(userId, nowMs);
      return;
    }
    await this.deps.stateStore.update((state) => ({
      next: {
        version: 1,
        userLastFollowUpAt: {
          ...state.userLastFollowUpAt,
          [userId]: nowMs,
        },
      },
      result: undefined,
    }));
  }

  private async runWithFollowUpLock<T>(
    userId: string,
    task: () => Promise<T>
  ): Promise<T> {
    const prev = this.followUpLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.then(
      () => nextLock,
      () => nextLock
    );
    this.followUpLocks.set(userId, chain);
    await prev.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.followUpLocks.get(userId) === chain) {
        this.followUpLocks.delete(userId);
      }
    }
  }

  private async executeFollowUpInner(
    session: AiChatHist,
    sessionId: string,
    note: Note,
    reactor: User,
    reaction: string
  ): Promise<boolean> {
    const playbookText = await this.deps.playbookLoader.load();
    const systemPrompt = [
      SAFETY_CONSTRAINTS,
      '',
      MISSKEY_FORMAT_CONSTRAINTS,
      '',
      playbookText,
      '',
      '【リアクションへの追いリプ判定】',
      '自分の投稿に対して相手がリアクションを付けました。会話の流れから自然で一言添えたい場合のみ短い追いリプ(1文)を返します。',
      '基本的には無理に返さず {"shouldReply": false, "text": null} を選んでください。',
      '出力JSON形式: {"shouldReply": boolean, "text": string | null}',
      '※ text の先頭に @ユーザー名 は含めないでください（システムが付与します）。',
    ].join('\n');

    const userPayload = JSON.stringify({
      reaction,
      my_last_note: (note.text ?? '').slice(0, 200),
      recent_history: (session.history ?? []).slice(-4),
    });

    const decision = this.deps.callLlm
      ? await this.deps.callLlm(systemPrompt, userPayload)
      : await callStructuredJson<ReactionFollowUpDecision>({
          system: systemPrompt,
          user: userPayload,
          maxTokens: FOLLOWUP_MAX_TOKENS,
          timeoutMs: FOLLOWUP_TIMEOUT_MS,
          log: this.log,
          parse: parseReactionFollowUpDecision,
        });

    if (!decision || !decision.shouldReply || !decision.text) {
      return false;
    }

    // 二重実行を確実に防ぐため送信前にフラグを立てる
    const fresh =
      this.deps.history.findBySessionId(sessionId) ??
      this.deps.history.findByPostId(note.id);
    if (
      !fresh ||
      fresh.followUpUsed ||
      (fresh.latestPostId ?? fresh.postId) !== note.id ||
      this.hasUserReply(note.id, reactor.id)
    ) {
      return false;
    }

    const body = decision.text.trim();
    const mentionPrefix = acct(reactor);
    const replyText = body.startsWith(mentionPrefix)
      ? body
      : `${mentionPrefix} ${body}`;

    const visibility = this.deps.postNotPublic
      ? 'home'
      : note.visibility === 'home'
        ? 'home'
        : 'public';

    const created = await this.deps.post({
      replyId: note.id,
      visibility,
      text: replyText,
    });

    const nowMs = this.now();
    await this.recordFollowUpAt(reactor.id, nowMs);
    const nextHistory = [
      ...(fresh.history ?? []),
      { role: 'model', content: body },
    ];
    while (nextHistory.length > DEFAULTS.MAX_HISTORY_LENGTH) {
      nextHistory.shift();
    }

    const postIds = [...(fresh.postIds ?? [fresh.postId]), created.id].slice(
      -3
    );
    const nextSnapshots: NonNullable<AiChatHist['historySnapshots']> = {};
    for (const postId of postIds) {
      const snapshot = fresh.historySnapshots?.[postId];
      if (snapshot) {
        nextSnapshots[postId] = snapshot.map((item) => ({ ...item }));
      }
    }
    nextSnapshots[created.id] = nextHistory.map((item) => ({ ...item }));

    fresh.followUpUsed = true;
    fresh.postId = created.id;
    fresh.latestPostId = created.id;
    fresh.postIds = postIds;
    fresh.updatedAt = nowMs;
    fresh.expiresAt = nowMs + TIMEOUT_TIME;
    fresh.history = nextHistory;
    fresh.historySnapshots = nextSnapshots;
    this.deps.history.update(fresh);

    const key = fresh.sessionId ?? sessionId;
    this.deps.subscribeReply(key, false, created.id, {
      sessionId: key,
      historyLength: nextHistory.length,
    });

    return true;
  }
}
