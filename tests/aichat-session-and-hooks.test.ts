import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import loki from 'lokijs';
import type * as Misskey from 'misskey-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 藍, { type HandlerResult } from '../src/ai.js';
import { initConfig, resolveConfig } from '../src/config/index.js';
import { ContextRepository } from '../src/database/repositories.js';
import type Message from '../src/message.js';
import type { Note, User } from '../src/misskey/types.js';
import { AffinityStore } from '../src/modules/aichat/affinity-store.js';
import { ChatHandler } from '../src/modules/aichat/chat-handler.js';
import {
  type AiChatHist,
  ChatHistoryRepository,
} from '../src/modules/aichat/history-repository.js';
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
    expect(removedContexts).toEqual(['p1']);
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
    const affinityStore = new AffinityStore({
      filePath: join(dir, 'aichat-affinity.json'),
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
    await affinityStore.applyInteractionUpdate({
      user: alice,
      isMaster: false,
      delta: 5,
      note: null,
      userText: '親しい状態のベース作成用メッセージです',
      source: 'chat',
    });

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
      isMasterUser: () => true,
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

    const notif = {
      id: 'notif-1',
      createdAt: new Date(nowMs).toISOString(),
      type: 'reaction',
      user: alice,
      userId: alice.id,
      reaction: '🎉',
      note: {
        id: 'bot-note-1',
        userId: 'bot-id',
        visibility: 'public',
        text: '元気ですか？',
      },
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
  });
});
