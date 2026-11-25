import loki from 'lokijs';
import { describe, expect, it } from 'vitest';
import {
  type AiChatHist,
  ChatHistoryRepository,
} from '../src/modules/aichat/history-repository.js';

function setup() {
  const db = new loki('test-aichat-history');
  const collection = db.addCollection<AiChatHist>('aichat_histories', {
    indices: ['postId', 'originalNoteId'],
  });
  return new ChatHistoryRepository(collection);
}

function hist(postId: string): AiChatHist {
  return { postId, createdAt: Date.now(), type: 'note', fromMention: false };
}

describe('ChatHistoryRepository', () => {
  it('finds a history by any post id in the conversation chain', () => {
    const repo = setup();
    repo.insert(hist('note-b'));
    repo.insert(hist('note-x'));

    // 会話チェーン [note-a, note-b, note-c] のいずれかに一致すれば既出と判定する
    const found = repo.findAnyByPostIds(['note-a', 'note-b', 'note-c']);
    expect(found?.postId).toBe('note-b');
  });

  it('returns null when no post id matches', () => {
    const repo = setup();
    repo.insert(hist('note-b'));
    expect(repo.findAnyByPostIds(['note-a', 'note-c'])).toBeNull();
  });

  it('prefers the earliest matching id in the chain', () => {
    const repo = setup();
    repo.insert(hist('note-a'));
    repo.insert(hist('note-c'));
    const found = repo.findAnyByPostIds(['note-a', 'note-c']);
    expect(found?.postId).toBe('note-a');
  });

  it('finds by sessionId, postIds sliding window, and expired records', () => {
    const repo = setup();
    repo.insert({
      ...hist('note-3'),
      sessionId: 'sess-1',
      postIds: ['note-1', 'note-2', 'note-3'],
      createdAt: 1000,
      expiresAt: 2000,
    });

    expect(repo.findBySessionId('sess-1')?.postId).toBe('note-3');
    expect(repo.findByPostId('note-1')?.sessionId).toBe('sess-1');
    expect(repo.findExpired(1500)).toHaveLength(0);
    expect(repo.findExpired(2000)).toHaveLength(1);

    const record = repo.findBySessionId('sess-1')!;
    record.expiresAt = 5000;
    repo.update(record);
    expect(repo.findExpired(3000)).toHaveLength(0);
  });
});
