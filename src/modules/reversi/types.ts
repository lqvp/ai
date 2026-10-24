import type { User } from '@/misskey/user.js';

/**
 * reversi/match API やストリームから受け取る対局データ。
 * 利用しているフィールドのみ型を定義し、それ以外は許容する。
 */
export type ReversiGame = {
  id: string;
  user1Id: string;
  user2Id: string;
  user1: User;
  user2: User;
  /** 黒番 (1: user1, 2: user2) */
  black?: number;
  map: string[];
  isLlotheo?: boolean;
  canPutEverywhere?: boolean;
  loopedBoard?: boolean;
  surrendered?: boolean;
  [key: string]: unknown;
};

/** 対局開始時に親プロセスからバックエンドへ渡される設定フォームの項目 */
export type ReversiFormItem = {
  id: string;
  type: string;
  label: string;
  value: boolean | number;
  items?: { label: string; value: number }[];
};

/** バックエンドプロセスが受け取るIPC/ストリームメッセージ */
export type BackendMessage =
  | {
      type: '_init_';
      body: { game: ReversiGame; form: ReversiFormItem[]; account: User };
    }
  | { type: 'started'; body: { game: ReversiGame } }
  | { type: 'ended'; body: { game: ReversiGame; winnerId?: string } }
  | { type: 'log'; body: { id?: string; operation: string; pos: number } };
