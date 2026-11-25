import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import loki from 'lokijs';
import type * as Misskey from 'misskey-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 藍, { type HandlerResult } from '../src/ai.js';
import { initConfig, resolveConfig } from '../src/config/index.js';
import { ContextRepository } from '../src/database/repositories.js';
import type Message from '../src/message.js';
import type { Note, User } from '../src/misskey/types.js';
import { AffinityStore } from '../src/modules/aichat/affinity-store.js';
import { ChatHandler } from '../src/modules/aichat/chat-handler.js';
import { TIMEOUT_TIME } from '../src/modules/aichat/constants.js';
import {
  type AiChatHist,
  ChatHistoryRepository,
} from '../src/modules/aichat/history-repository.js';
import AiChatModule from '../src/modules/aichat/index.js';
import { PlaybookLoader } from '../src/modules/aichat/playbook.js';
import { ReactionFollowUpHandler } from '../src/modules/aichat/reaction-followup.js';

const dirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-aichat-session-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  initConfig(
    resolveConfig({
      host: 'https://example.com',
      i: 'token',
      master: 'admin',
      gemini: { enabled: true, apiKey: 'g-key', chat: { enabled: true } },
    })
  );
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFakeAi(replyResult: { id: string } | Error) {
  return {
    lookupFriend: () => null,
    relationship: { isMaster: () => false },
    api: async () => ({ files: [] }),
    sendMessage: async () => undefined,
    replyImpl: replyResult,
  };
}

function createFakeMessage(
  extractedText: string,
  replyResult: { id: string } | Error,
  overrides: Partial<Message> = {}
): Message {
  return {
    id: 'msg-1',
    userId: 'u-1',
    user: { id: 'u-1', username: 'alice', host: null, name: 'Alice' } as User,
    text: extractedText,
    extractedText,
    isChat: false,
    includes: () => false,
    reply: async () => {
      if (replyResult instanceof Error) throw replyResult;
      return replyResult;
    },
    ...overrides,
  } as unknown as Message;
}

function installModuleForContextTest(dir: string, db: loki) {
  initConfig(
    resolveConfig({
      host: 'https://example.com',
      i: 'token',
      master: 'admin',
      memoryDir: dir,
      gemini: { enabled: true, apiKey: 'g-key', chat: { enabled: true } },
      aichat: {
        enabled: true,
        followingOnly: false,
        wander: { enabled: false },
        affinity: { enabled: false },
        reactionFollowUp: { enabled: false },
      },
    })
  );

  const contexts = new ContextRepository(
    db.getCollection('contexts') ??
      db.addCollection('contexts', { indices: ['noteId', 'userId', 'module'] })
  );
  const fakeAi = {
    account: { id: 'bot-id', username: 'ai', name: '藍' },
    log: () => {},
    repos: {
      contexts,
      moduleData: {
        ensure: () => ({ module: 'aichat', data: {} }),
        save: () => {},
      },
    },
    getCollection: <T extends object>(
      name: string,
      opts?: { indices?: (keyof T)[] }
    ) => db.getCollection<T>(name) ?? db.addCollection<T>(name, opts),
    relationship: { isMaster: () => false, isFollowing: async () => true },
    reactions: { react: async () => true },
    lookupFriend: () => null,
    subscribeReply: (
      module: { name: string },
      key: string | null,
      isChat: boolean,
      id: string,
      data?: unknown
    ) =>
      contexts.subscribe({
        isChat,
        ...(isChat ? { userId: id } : { noteId: id }),
        module: module.name,
        key,
        data,
      }),
    unsubscribeReply: (module: { name: string }, key: string | null) =>
      contexts.removeByKey(module.name, key),
    connection: {
      useSharedConnection: () => ({ on: () => {}, dispose: () => {} }),
    },
    api: async () => ({ files: [] }),
    post: async () => ({ id: 'unused-post' }),
    sendMessage: async () => undefined,
  } as unknown as 藍;

  const mod = new AiChatModule();
  mod.init(fakeAi);
  const hooks = mod.getHooks();
  return { mod, hooks, contexts };
}

function createReplyMessage(overrides: Partial<Message>): Message {
  return {
    id: 'reply-msg-1',
    userId: 'u-alice',
    user: {
      id: 'u-alice',
      username: 'alice',
      host: null,
      isBot: false,
    } as User,
    text: '続きです',
    extractedText: '続きです',
    isChat: false,
    replyId: 'bot-reply-1',
    includes: () => false,
    reply: async () => ({ id: 'unused-reply' }),
    friend: null,
    ...overrides,
  } as unknown as Message;
}

describe('ChatHandler lifecycle, sentinels, image-only, and hashtags', () => {
  it('preserves history & context when reply fails, and supports image-only notes', async () => {
    const db = new loki('chat-test');
    const history = new ChatHistoryRepository(
      db.addCollection<AiChatHist>('aichatHist', {
        indices: ['sessionId', 'postId', 'chatUserId'],
      })
    );
    const removedContexts: string[] = [];
    const subscriptions: Array<{ key: string; id: string }> = [];

    const exist: AiChatHist = {
      sessionId: 'sess-1',
      postId: 'prev-1',
      postIds: ['prev-1'],
      createdAt: 1000,
      expiresAt: 1000 + 30 * 60_000,
      type: 'gemini',
      fromMention: true,
      history: [{ role: 'user', content: 'hi' }],
    };
    history.insert(exist);

    // 1. 返信失敗時は履歴を消さずに failed を返す
    const failingHandler = new ChatHandler({
      ai: createFakeAi(new Error('network down')) as unknown as 藍,
      moduleName: 'aichat',
      history,
      log: () => {},
      genTextDetailed: async () => ({ text: 'お返事です', metadataSuffix: '' }),
      subscribeReply: (key, _isChat, id) => subscriptions.push({ key, id }),
      removeOldNoteContext: (id) => removedContexts.push(id),
      later: () => {},
    });

    const failRes = await failingHandler.handle(
      exist,
      createFakeMessage('aichat テスト', new Error('send failed'))
    );
    expect(failRes.status).toBe('failed');
    expect(history.findBySessionId('sess-1')?.history).toHaveLength(1);
    expect(subscriptions).toHaveLength(0);

    // 2. 画像のみノート（テキスト空 + 添付ファイルあり）でも処理でき、postIds は最大3件を維持
    const aiWithImage = createFakeAi({ id: 'reply-4' });
    aiWithImage.api = async () =>
      ({
        files: [{ type: 'image/png', url: 'https://example.com/a.png' }],
      }) as never;

    let capturedQuestion = '';
    const okHandler = new ChatHandler({
      ai: {
        ...createFakeAi({ id: 'reply-4' }),
        api: async () => ({ files: [] }),
      } as unknown as 藍,
      moduleName: 'aichat',
      history,
      log: () => {},
      genTextDetailed: async (aiChat) => {
        capturedQuestion = aiChat.question;
        return {
          text: '画像ですね',
          metadataSuffix: '参考(1): [Site](https://example.com)',
        };
      },
      subscribeReply: (key, _isChat, id) => subscriptions.push({ key, id }),
      removeOldNoteContext: (id) => removedContexts.push(id),
      later: () => {},
      now: () => 5000,
    });

    // 画像ファイルありのケース（quotedFiles 経由で添付）
    exist.postIds = ['p1', 'p2', 'p3'];
    exist.historySnapshots = {
      p1: [{ role: 'model', content: 'old-1' }],
      p2: [{ role: 'model', content: 'old-2' }],
      p3: [{ role: 'model', content: 'old-3' }],
    };
    exist.quotedFiles = [{ type: 'image/png', base64: 'AAAA' }];
    let postedText = '';
    const msgImg = createFakeMessage('', { id: 'reply-4' });
    (
      msgImg as unknown as { reply: (t: string) => Promise<{ id: string }> }
    ).reply = async (t: string) => {
      postedText = t;
      return { id: 'reply-4' };
    };

    const okRes = await okHandler.handle(exist, msgImg);
    expect(okRes.status).toBe('replied');
    expect(capturedQuestion).toBe('(添付画像のみ)');
    // 明示的メンション公開ノートには #aichat と metadataSuffix が付くが、history には clean な本文だけ入る
    expect(postedText).toContain('#aichat');
    expect(postedText).toContain('参考(1):');
    const saved = history.findBySessionId('sess-1');
    expect(saved?.history?.at(-1)?.content).toBe('画像ですね');
    expect(saved?.postIds).toEqual(['p2', 'p3', 'reply-4']);
    expect(saved?.historySnapshots?.p1).toBeUndefined();
    expect(saved?.historySnapshots?.p2).toEqual([
      { role: 'model', content: 'old-2' },
    ]);
    expect(saved?.historySnapshots?.['reply-4']).toEqual(saved?.history);
    expect(removedContexts).toEqual(['p1']);
  });

  it('inserts a branched session copied from a Loki record as a separate document', () => {
    const db = new loki('branch-insert-test');
    const history = new ChatHistoryRepository(
      db.addCollection<AiChatHist>('aichatHist', { indices: ['sessionId'] })
    );

    history.insert({
      sessionId: 'sess-original',
      postId: 'p1',
      createdAt: 1,
      type: 'gemini',
      fromMention: true,
      history: [{ role: 'user', content: 'hi' }],
    });
    const original = history.findBySessionId('sess-original');
    expect(original).not.toBeNull();

    const branch: AiChatHist = {
      ...original!,
      sessionId: 'sess-branch',
      postIds: [],
      ownerUserId: 'another-user',
    };
    expect(() => history.insert(branch)).not.toThrow();

    expect(history.findBySessionId('sess-original')?.postId).toBe('p1');
    expect(history.findBySessionId('sess-branch')?.ownerUserId).toBe(
      'another-user'
    );
    expect(history.all()).toHaveLength(2);
  });

  it('honors gemini.chat.enabled=false even when aichat module is explicitly enabled', async () => {
    initConfig(
      resolveConfig({
        host: 'https://example.com',
        i: 'token',
        master: 'admin',
        gemini: { enabled: true, apiKey: 'g-key', chat: { enabled: false } },
        aichat: { enabled: true },
      })
    );
    const db = new loki('chat-disabled-test');
    const history = new ChatHistoryRepository(
      db.addCollection<AiChatHist>('aichatHist')
    );
    let llmCalled = false;
    const handler = new ChatHandler({
      ai: createFakeAi({ id: 'x' }) as unknown as 藍,
      moduleName: 'aichat',
      history,
      log: () => {},
      genTextDetailed: async () => {
        llmCalled = true;
        return { text: '応答', metadataSuffix: '' };
      },
      subscribeReply: () => {},
      later: () => {},
    });

    const result = await handler.handle(
      { postId: 'p1', createdAt: 0, type: 'gemini', fromMention: true },
      createFakeMessage('aichat こんにちは', { id: 'x' })
    );

    expect(result.status).toBe('failed');
    expect(llmCalled).toBe(false);
  });

  it('handles [[IGNORE]] and [[REACT_ONLY]] sentinels without posting', async () => {
    const db = new loki('sentinel-test');
    const history = new ChatHistoryRepository(
      db.addCollection<AiChatHist>('aichatHist')
    );
    let replyCalled = false;

    const makeHandler = (text: string) =>
      new ChatHandler({
        ai: createFakeAi({ id: 'x' }) as unknown as 藍,
        moduleName: 'aichat',
        history,
        log: () => {},
        genTextDetailed: async () => ({ text, metadataSuffix: '' }),
        subscribeReply: () => {},
        later: () => {},
      });

    const msg = createFakeMessage('aichat ねぇ', { id: 'x' });
    (msg as unknown as { reply: () => Promise<void> }).reply = async () => {
      replyCalled = true;
    };

    const ignored = await makeHandler('[[IGNORE]]').handle(
      { postId: 'p1', createdAt: 0, type: 'gemini', fromMention: true },
      msg
    );
    expect(ignored.status).toBe('ignored');
    expect(replyCalled).toBe(false);

    const reactOnly = await makeHandler('[[REACT_ONLY]]').handle(
      { postId: 'p1', createdAt: 0, type: 'gemini', fromMention: true },
      msg
    );
    expect(reactOnly.status).toBe('react_only');
    expect(replyCalled).toBe(false);
  });
});

describe('aichat contextHook branching and ignore boundaries', () => {
  it("does not delete another user's session when a low-affinity third party replies", async () => {
    const dir = createTempDir();
    const db = new loki('context-ignore-test');
    const { mod, hooks } = installModuleForContextTest(dir, db);
    const history = new ChatHistoryRepository(
      db.getCollection<AiChatHist>('aichatHist')!
    );
    history.insert({
      sessionId: 'sess-owner',
      postId: 'bot-reply-1',
      latestPostId: 'bot-reply-1',
      postIds: ['bot-reply-1'],
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 60_000,
      type: 'gemini',
      fromMention: true,
      ownerUserId: 'u-alice',
      history: [{ role: 'model', content: '元の会話' }],
    });

    (
      mod as unknown as {
        checkPreLlmIgnore: (msg: Message) => Promise<boolean>;
      }
    ).checkPreLlmIgnore = async () => true;

    const bobMsg = createReplyMessage({
      id: 'bob-reply',
      userId: 'u-bob',
      user: {
        id: 'u-bob',
        username: 'bob',
        host: null,
        isBot: false,
      } as User,
    });
    const result = await hooks.contextHook!('sess-owner', bobMsg, {
      sessionId: 'sess-owner',
    });

    expect(result).toEqual({ reaction: null, immediate: true });
    expect(history.findBySessionId('sess-owner')).not.toBeNull();
    mod.dispose();
  });

  it('branches from the replied note snapshot instead of ambiguous history length', async () => {
    const dir = createTempDir();
    const db = new loki('context-branch-test');
    const { mod, hooks } = installModuleForContextTest(dir, db);
    const history = new ChatHistoryRepository(
      db.getCollection<AiChatHist>('aichatHist')!
    );
    const firstTurn = [
      { role: 'user', content: '最初の質問' },
      { role: 'model', content: '最初の回答' },
    ];
    const currentTurn = [
      ...firstTurn,
      { role: 'user', content: '二つ目の質問' },
      { role: 'model', content: '二つ目の回答' },
    ];
    history.insert({
      sessionId: 'sess-branch-base',
      postId: 'bot-reply-2',
      latestPostId: 'bot-reply-2',
      postIds: ['bot-reply-1', 'bot-reply-2'],
      createdAt: 1,
      updatedAt: 2,
      expiresAt: Date.now() + 60_000,
      type: 'gemini',
      fromMention: true,
      ownerUserId: 'u-alice',
      history: currentTurn,
      historySnapshots: {
        'bot-reply-1': firstTurn,
        'bot-reply-2': currentTurn,
      },
    });

    const captured: AiChatHist[] = [];
    (mod as unknown as { chatHandler: ChatHandler }).chatHandler = {
      handle: async (hist: AiChatHist) => {
        captured.push({
          ...hist,
          history: hist.history?.map((item) => ({ ...item })),
        });
        return { status: 'failed' };
      },
    } as unknown as ChatHandler;

    const bobMsg = createReplyMessage({
      id: 'bob-old-turn-reply',
      userId: 'u-bob',
      user: {
        id: 'u-bob',
        username: 'bob',
        host: null,
        isBot: false,
      } as User,
      replyId: 'bot-reply-1',
    });
    await hooks.contextHook!('sess-branch-base', bobMsg, {
      sessionId: 'sess-branch-base',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].sessionId).not.toBe('sess-branch-base');
    expect(captured[0].ownerUserId).toBe('u-bob');
    expect(captured[0].history).toEqual(firstTurn);
    expect(captured[0].postIds).toEqual([]);

    const aliceLatestMsg = createReplyMessage({
      id: 'alice-latest-reply',
      replyId: 'bot-reply-2',
    });
    await hooks.contextHook!('sess-branch-base', aliceLatestMsg, {
      sessionId: 'sess-branch-base',
    });

    expect(captured).toHaveLength(2);
    expect(captured[1].sessionId).toBe('sess-branch-base');
    expect(captured[1].history).toEqual(currentTurn);
    expect(captured[1].expiresAt).toBeGreaterThanOrEqual(
      Date.now() + TIMEOUT_TIME - 1000
    );
    mod.dispose();
  });

  it('keeps a session alive past its original expiry while generation is in flight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));

    const dir = createTempDir();
    const db = new loki('context-active-generation-test');
    const { mod, hooks } = installModuleForContextTest(dir, db);
    const history = new ChatHistoryRepository(
      db.getCollection<AiChatHist>('aichatHist')!
    );
    const startMs = Date.now();
    history.insert({
      sessionId: 'sess-active-generation',
      postId: 'bot-reply-active',
      latestPostId: 'bot-reply-active',
      postIds: ['bot-reply-active'],
      createdAt: startMs - 30 * 60_000,
      updatedAt: startMs - 1000,
      expiresAt: startMs + 1000,
      type: 'gemini',
      fromMention: true,
      ownerUserId: 'u-alice',
      history: [{ role: 'model', content: '元の会話' }],
    });

    let releaseLlm!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });
    (mod as unknown as { chatHandler: ChatHandler }).chatHandler = {
      handle: async () => {
        markStarted();
        await llmGate;
        return { status: 'failed' };
      },
    } as unknown as ChatHandler;

    try {
      const pending = hooks.contextHook!(
        'sess-active-generation',
        createReplyMessage({ replyId: 'bot-reply-active' }),
        { sessionId: 'sess-active-generation' }
      );
      await started;

      vi.setSystemTime(startMs + 2000);
      (
        mod as unknown as { sweepExpiredSessions: () => void }
      ).sweepExpiredSessions();

      expect(history.findBySessionId('sess-active-generation')).not.toBeNull();
      releaseLlm();
      await pending;
    } finally {
      releaseLlm?.();
      mod.dispose();
      vi.useRealTimers();
    }
  });
});

describe('ai.ts fallbackMentionHook & reaction: null contract', () => {
  it('suppresses default love reaction when hook returns { reaction: null } and never hijacks other module contexts', async () => {
    const db = new loki('ai-hooks-test');
    const contexts = new ContextRepository(
      db.addCollection('contexts', { indices: ['noteId', 'userId', 'module'] })
    );
    contexts.subscribe({
      isChat: true,
      userId: 'u-rem',
      module: 'reminder',
      key: 'rem-1',
    });

    const reacted: Array<string | null> = [];
    let fallbackCalled = false;

    const fakeAi = Object.create(藍.prototype) as Record<string, unknown>;
    fakeAi.log = () => {};
    fakeAi.dbManager = { repositories: { contexts } };
    fakeAi.reactions = {
      react: async (_id: string, reaction: string | null) => {
        reacted.push(reaction);
        return Boolean(reaction);
      },
    };
    fakeAi.contextHooks = {
      // reminder の contextHook が false を返したケース
      reminder: async () => false,
    };
    fakeAi.mentionHooks = [
      {
        module: 'aichat',
        handler: async (msg: Message): Promise<boolean | HandlerResult> => {
          if (msg.userId === 'u-ignore') {
            return { reaction: null, immediate: true };
          }
          return false;
        },
      },
    ];
    fakeAi.fallbackMentionHooks = [
      {
        module: 'aichat',
        handler: async () => {
          fallbackCalled = true;
          return { reaction: '✨', immediate: true };
        },
      },
    ];

    const onReceiveMessage = (
      藍.prototype as unknown as {
        onReceiveMessage: (msg: Message) => Promise<void>;
      }
    ).onReceiveMessage;

    // 1. 他モジュールの context があるメッセージでは fallbackMentionHook を発動させない
    await onReceiveMessage.call(fakeAi, {
      id: 'm1',
      userId: 'u-rem',
      isChat: true,
      replyId: null,
      user: { isBot: false },
      friend: null,
    } as unknown as Message);
    expect(fallbackCalled).toBe(false);

    // 2. { reaction: null, immediate: true } でデフォルト 'love' リアクションを抑止
    await onReceiveMessage.call(fakeAi, {
      id: 'm2',
      userId: 'u-ignore',
      isChat: false,
      replyId: null,
      user: { isBot: false },
      friend: null,
    } as unknown as Message);
    expect(reacted).toEqual([null]);

    // 3. context なし＆通常 mentionHook が全 false なら fallbackMentionHook が動く
    await onReceiveMessage.call(fakeAi, {
      id: 'm3',
      userId: 'u-normal',
      isChat: false,
      replyId: null,
      user: { isBot: false },
      friend: null,
    } as unknown as Message);
    expect(fallbackCalled).toBe(true);
    expect(reacted).toEqual([null, '✨']);
  });
});

describe('ReactionFollowUpHandler', () => {
  it('prepends @acct on follow-up reply and aborts if user replies before timer fires', async () => {
    const dir = createTempDir();
    const nowMs = Date.parse('2026-11-24T12:00:00Z');
    const db = new loki('followup-test');
    const history = new ChatHistoryRepository(
      db.addCollection<AiChatHist>('aichatHist', {
        indices: ['sessionId', 'postId'],
      })
    );
    const affinityPath = join(dir, 'aichat-affinity.json');
    const seededLast = new Date(nowMs - 60_000).toISOString();
    writeFileSync(
      affinityPath,
      `${JSON.stringify({
        version: 1,
        users: {
          '@alice': {
            userId: 'u-alice',
            score: 35,
            notes: '',
            last: seededLast,
          },
          '@bob': {
            userId: 'u-bob',
            score: 35,
            notes: '',
            last: seededLast,
          },
          '@carol': {
            userId: 'u-carol',
            score: 5,
            notes: '',
            last: seededLast,
          },
        },
      })}\n`,
      'utf8'
    );
    const affinityStore = new AffinityStore({
      filePath: affinityPath,
      now: () => nowMs,
    });
    const playbookLoader = new PlaybookLoader({
      filePath: join(dir, 'PLAYBOOK.md'),
    });

    const alice = {
      id: 'u-alice',
      username: 'alice',
      host: null,
      isBot: false,
    } as User;
    history.insert({
      sessionId: 'sess-f1',
      postId: 'bot-note-1',
      latestPostId: 'bot-note-1',
      postIds: ['bot-note-1'],
      createdAt: nowMs - 60_000,
      updatedAt: nowMs - 60_000,
      expiresAt: nowMs + 1_800_000,
      type: 'gemini',
      fromMention: true,
      ownerUserId: 'u-alice',
      history: [{ role: 'model', content: '元気ですか？' }],
    });

    const posts: Array<{ replyId?: string; text?: string | null }> = [];
    const handler = new ReactionFollowUpHandler({
      selfUserId: 'bot-id',
      history,
      affinityStore,
      playbookLoader,
      isMasterUser: () => false,
      post: async (param) => {
        posts.push(param);
        return { id: 'bot-followup-1' } as Note;
      },
      subscribeReply: () => {},
      config: {
        enabled: true,
        probability: 1,
        delaySeconds: 0,
      },
      now: () => nowMs,
      rng: () => 0,
      callLlm: async () => ({
        shouldReply: true,
        text: '嬉しいリアクションありがとう！',
      }),
    });

    const reactionNote = {
      id: 'bot-note-1',
      userId: 'bot-id',
      visibility: 'public',
      text: '元気ですか？',
    } as Note;
    const notif = {
      id: 'notif-1',
      createdAt: new Date(nowMs).toISOString(),
      type: 'reaction',
      user: alice,
      userId: alice.id,
      reaction: '🎉',
      note: reactionNote,
    } as unknown as Misskey.entities.Notification;

    expect(await handler.handleNotification(notif)).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe('@alice 嬉しいリアクションありがとう！');

    // latestPostId が変わっている（ユーザーが返信した）場合は中止する
    const aborted = await handler.executeFollowUp(
      'sess-f1',
      { id: 'bot-note-1', userId: 'bot-id', visibility: 'public' } as Note,
      alice,
      '🎉'
    );
    expect(aborted).toBe(false);

    // ユーザーの本文返信マーカーがある場合も、Bot投稿IDがまだ変わっていなくても中止する
    history.insert({
      sessionId: 'sess-f2',
      postId: 'bot-note-2',
      latestPostId: 'bot-note-2',
      postIds: ['bot-note-2'],
      createdAt: nowMs - 60_000,
      updatedAt: nowMs - 60_000,
      expiresAt: nowMs + 1_800_000,
      type: 'gemini',
      fromMention: true,
      ownerUserId: 'u-alice',
      history: [{ role: 'model', content: '別の会話' }],
    });
    handler.markUserReply('bot-note-2', alice.id);
    const abortedByUserReply = await handler.executeFollowUp(
      'sess-f2',
      { id: 'bot-note-2', userId: 'bot-id', visibility: 'public' } as Note,
      alice,
      '🎉'
    );
    expect(abortedByUserReply).toBe(false);
    expect(posts).toHaveLength(1);

    // affinity 機能スイッチが無効なら、条件不成立の通知でも好感度微増を記録しない
    const beforeDisabled = await affinityStore.getEntry(alice, {
      isMaster: false,
    });
    const disabledAffinityHandler = new ReactionFollowUpHandler({
      selfUserId: 'bot-id',
      history,
      affinityStore,
      playbookLoader,
      isMasterUser: () => false,
      post: async () => ({ id: 'unused' }) as Note,
      subscribeReply: () => {},
      affinityEnabled: false,
      config: { enabled: false },
      now: () => nowMs,
      rng: () => 0,
    });
    await disabledAffinityHandler.handleNotification(notif);
    const afterDisabled = await affinityStore.getEntry(alice, {
      isMaster: false,
    });
    expect(afterDisabled.score).toBe(beforeDisabled.score);

    // 既定の最低好感度30未満のユーザーには追いリプしない
    const carol = {
      id: 'u-carol',
      username: 'carol',
      host: null,
      isBot: false,
    } as User;
    history.insert({
      sessionId: 'sess-low-affinity',
      postId: 'bot-note-low',
      latestPostId: 'bot-note-low',
      postIds: ['bot-note-low'],
      createdAt: nowMs - 60_000,
      updatedAt: nowMs - 60_000,
      expiresAt: nowMs + 1_800_000,
      type: 'gemini',
      fromMention: true,
      ownerUserId: 'u-carol',
      history: [{ role: 'model', content: '低好感度の会話' }],
    });
    const carolNotif = {
      ...notif,
      id: 'notif-carol',
      user: carol,
      userId: carol.id,
      note: {
        ...reactionNote,
        id: 'bot-note-low',
      },
    } as unknown as Misskey.entities.Notification;
    expect(await handler.handleNotification(carolNotif)).toBe(false);
    expect(posts).toHaveLength(1);

    // 好感度JSONが構文破損していても、保存済みの状態で追いリプ判定は継続する
    const bob = {
      id: 'u-bob',
      username: 'bob',
      host: null,
      isBot: false,
    } as User;
    history.insert({
      sessionId: 'sess-f3',
      postId: 'bot-note-3',
      latestPostId: 'bot-note-3',
      postIds: ['bot-note-3'],
      createdAt: nowMs - 60_000,
      updatedAt: nowMs - 60_000,
      expiresAt: nowMs + 1_800_000,
      type: 'gemini',
      fromMention: true,
      ownerUserId: 'u-bob',
      history: [{ role: 'model', content: '破損時の会話' }],
    });
    writeFileSync(affinityPath, '{ broken json', 'utf8');

    const bobNotif = {
      ...notif,
      id: 'notif-bob',
      user: bob,
      userId: bob.id,
      note: {
        ...reactionNote,
        id: 'bot-note-3',
      },
    } as unknown as Misskey.entities.Notification;
    expect(await handler.handleNotification(bobNotif)).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[1].text).toBe('@bob 嬉しいリアクションありがとう！');
    expect(readFileSync(affinityPath, 'utf8')).toBe('{ broken json');
  });
});

describe('ReactionFollowUpHandler concurrency', () => {
  it('serializes simultaneous follow-up executions for the same user', async () => {
    const dir = createTempDir();
    const nowMs = Date.parse('2026-11-24T12:00:00Z');
    const db = new loki('followup-concurrency-test');
    const history = new ChatHistoryRepository(
      db.addCollection<AiChatHist>('aichatHist')
    );
    history.insert({
      sessionId: 'sess-concurrent',
      postId: 'bot-note-concurrent',
      latestPostId: 'bot-note-concurrent',
      postIds: ['bot-note-concurrent'],
      createdAt: nowMs - 60_000,
      updatedAt: nowMs - 60_000,
      expiresAt: nowMs + 1_800_000,
      type: 'gemini',
      fromMention: true,
      ownerUserId: 'u-alice',
      history: [{ role: 'model', content: '元気ですか？' }],
    });
    const alice = {
      id: 'u-alice',
      username: 'alice',
      host: null,
      isBot: false,
    } as User;
    const note = {
      id: 'bot-note-concurrent',
      userId: 'bot-id',
      visibility: 'public',
      text: '元気ですか？',
    } as Note;
    let releaseLlm!: (value: { shouldReply: boolean; text: string }) => void;
    const llmGate = new Promise<{ shouldReply: boolean; text: string }>(
      (resolve) => {
        releaseLlm = resolve;
      }
    );
    const posts: Array<{ text?: string | null }> = [];
    const handler = new ReactionFollowUpHandler({
      selfUserId: 'bot-id',
      history,
      affinityStore: new AffinityStore({
        filePath: join(dir, 'aichat-affinity.json'),
        now: () => nowMs,
      }),
      playbookLoader: new PlaybookLoader({
        filePath: join(dir, 'PLAYBOOK.md'),
      }),
      isMasterUser: () => false,
      post: async (param) => {
        posts.push(param);
        return { id: `bot-followup-${posts.length}` } as Note;
      },
      subscribeReply: () => {},
      now: () => nowMs,
      rng: () => 0,
      callLlm: () => llmGate,
    });

    const first = handler.executeFollowUp('sess-concurrent', note, alice, '🎉');
    const second = handler.executeFollowUp(
      'sess-concurrent',
      note,
      alice,
      '🎉'
    );
    releaseLlm({ shouldReply: true, text: 'ありがとう！' });
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(posts).toHaveLength(1);
  });
});
