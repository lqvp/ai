import config from '@/config/index.js';
import { normalizeAcct } from './affinity-store.js';

type UserRef = {
  id?: string;
  username?: string;
  host?: string | null;
};

/** 設定上の blocklist かどうかをユーザーID/acct双方で判定する。 */
export function isBlockedAichatUser(user: UserRef): boolean {
  const blocked = config.aichat?.engagement?.blockedUsers ?? [];
  if (blocked.length === 0) return false;
  const username = user.username;
  const acct = username
    ? normalizeAcct({ ...user, username }).toLowerCase()
    : '';
  return blocked.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized === user.id || normalized === acct;
  });
}
