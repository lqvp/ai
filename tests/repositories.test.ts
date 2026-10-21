import loki from 'lokijs';
import { describe, expect, it } from 'vitest';
import {
  ContextRepository,
  FriendRepository,
  ModuleDataRepository,
  TimerRepository,
} from '../src/database/repositories.js';
import type { FriendDoc } from '../src/friend.js';
import type { User } from '../src/misskey/user.js';

function createDb<T extends object>(
  name: string,
  indices: (keyof T & string)[]
) {
  const db = new loki('test.db');
  return db.addCollection<T>(name, { indices });
}

const user = (id: string): User =>
  ({ id, username: `user${id}`, host: null }) as unknown as User;

describe('FriendRepository', () => {
  it('creates once and merges subsequent updates', () => {
    const repo = new FriendRepository(
      createDb<FriendDoc>('friends', ['userId'])
    );
    const created = repo.upsert(user('1'));
    expect(created.userId).toBe('1');

    const updated = repo.upsert({ ...user('1'), name: '藍' });
    expect(updated.user.name).toBe('藍');
    expect(repo.all()).toHaveLength(1);
  });
});

describe('ContextRepository', () => {
  it('finds note and chat contexts', () => {
    const repo = new ContextRepository(
      createDb('contexts', ['noteId', 'userId', 'module'])
    );
    repo.insert({ isChat: false, noteId: 'n1', module: 'a', key: 'k' });
    repo.insert({ isChat: true, userId: 'u1', module: 'a', key: 'k' });

    expect(repo.findForNote('n1')?.module).toBe('a');
    expect(repo.findForNote(null)).toBeNull();
    expect(repo.findForChat('u1')?.isChat).toBe(true);
  });

  it('replaces an existing subscription for the same target', () => {
    const repo = new ContextRepository(createDb('contexts', ['noteId']));
    repo.subscribe({ isChat: false, noteId: 'n1', module: 'a', key: 'a1' });
    repo.subscribe({ isChat: false, noteId: 'n1', module: 'b', key: 'b1' });

    expect(repo.findForNote('n1')?.module).toBe('b');
  });

  it('replaces a chat subscription from the same user', () => {
    const repo = new ContextRepository(createDb('contexts', ['userId']));
    repo.subscribe({ isChat: true, userId: 'u1', module: 'a', key: 'a1' });
    repo.subscribe({ isChat: true, userId: 'u1', module: 'b', key: 'b1' });

    expect(repo.findForChat('u1')?.key).toBe('b1');
  });

  it('removes by module and key', () => {
    const repo = new ContextRepository(createDb('contexts', ['module']));
    repo.insert({ isChat: false, noteId: 'n1', module: 'a', key: 'k' });
    repo.insert({ isChat: false, noteId: 'n2', module: 'a', key: 'k2' });

    repo.removeByKey('a', 'k');
    expect(repo.findForNote('n1')).toBeNull();

    expect(repo.removeByModule('a')).toBe(1);
    expect(repo.findForNote('n2')).toBeNull();
  });
});

describe('TimerRepository', () => {
  it('returns only due timers', () => {
    const repo = new TimerRepository(createDb('timers', ['insertedAt']));
    repo.insert({ id: '1', module: 'a', insertedAt: 0, delay: 100 });
    repo.insert({ id: '2', module: 'a', insertedAt: 0, delay: 10_000 });

    expect(repo.due(500).map((t) => t.id)).toEqual(['1']);
  });
});

describe('ModuleDataRepository', () => {
  it('ensures a single document per module', () => {
    const repo = new ModuleDataRepository(createDb('moduleData', ['module']));
    const first = repo.ensure('aichat');
    first.data.counter = 1;
    repo.save(first);

    const second = repo.ensure('aichat');
    expect(second.data.counter).toBe(1);
  });
});
