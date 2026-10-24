import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as childProcess from 'child_process';
import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Friend from '@/friend.js';
import Message from '@/message.js';
import type { User } from '@/misskey/user.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import type { SharedConnection } from '@/stream.js';
import getDate from '@/utils/get-date.js';
import type { ReversiFormItem, ReversiGame } from './types.js';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

export default class extends Module {
  /** 対局ごとに fork したバックエンド。停止時に確実に kill する。 */
  private backends = new Set<childProcess.ChildProcess>();
  public readonly name = 'reversi';

  /**
   * リバーシストリーム
   */
  private reversiConnection?: SharedConnection;

  @bindThis
  public install() {
    if (!config.reversiEnabled) return false;

    this.reversiConnection = this.ai.connection.useSharedConnection('reversi');

    // 招待されたとき
    this.reversiConnection.on('invited', (msg: { user: User }) =>
      this.onReversiInviteMe(msg.user)
    );

    // マッチしたとき
    this.reversiConnection.on('matched', (msg: { game: ReversiGame }) =>
      this.onReversiGameStart(msg.game)
    );

    if (config.reversiEnabled) {
      const mainStream = this.ai.connection.useSharedConnection('main');
      mainStream.on('pageEvent', (msg: { event: string; user: User }) => {
        if (msg.event === 'inviteReversi') {
          this.ai.api('games/reversi/match', {
            userId: msg.user.id,
          });
        }
      });
    }

    return {
      mentionHook: this.mentionHook,
    };
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (msg.includes(['リバーシ', 'オセロ', 'reversi', 'othello'])) {
      if (config.reversiEnabled) {
        msg.reply(serifs.reversi.ok);

        if (msg.includes(['接待'])) {
          msg.friend.updateReversiStrength(0);
        }

        this.ai.api('reversi/match', {
          userId: msg.userId,
        });
      } else {
        msg.reply(serifs.reversi.decline);
      }

      return true;
    } else {
      return false;
    }
  }

  @bindThis
  private async onReversiInviteMe(inviter: User) {
    this.log(`Someone invited me: @${inviter.username}`);

    if (config.reversiEnabled) {
      // 承認
      const game = await this.ai.api<ReversiGame>('reversi/match', {
        userId: inviter.id,
      });

      this.onReversiGameStart(game);
    } else {
      // todo (リバーシできない旨をメッセージで伝えるなど)
    }
  }

  @bindThis
  private onReversiGameStart(game: ReversiGame) {
    let strength = 4;
    const friend = this.ai.lookupFriend(
      game.user1Id !== this.ai.account.id ? game.user1Id : game.user2Id
    )!;
    if (friend != null) {
      strength = friend.doc.reversiStrength ?? 4;
      friend.updateReversiStrength(null);
    }

    this.log(`enter reversi game room: ${game.id}`);

    // ゲームストリームに接続
    const gw = this.ai.connection.connectToChannel('reversiGame', {
      gameId: game.id,
    });

    // フォーム
    const form: ReversiFormItem[] = [
      {
        id: 'publish',
        type: 'switch',
        label: '藍が対局情報を投稿するのを許可',
        value: true,
      },
      {
        id: 'strength',
        type: 'radio',
        label: '強さ',
        value: strength,
        items: [
          {
            label: '接待',
            value: 0,
          },
          {
            label: '弱',
            value: 2,
          },
          {
            label: '中',
            value: 3,
          },
          {
            label: '強',
            value: 4,
          },
          {
            label: '最強',
            value: 5,
          },
        ],
      },
    ];

    //#region バックエンドプロセス開始
    const ai = childProcess.fork(_dirname + '/back.js');
    this.backends.add(ai);
    ai.once('exit', () => this.backends.delete(ai));

    // バックエンドプロセスに情報を渡す
    ai.send({
      type: '_init_',
      body: {
        game: game,
        form: form,
        account: this.ai.account,
      },
    });

    ai.on(
      'message',
      (
        msg: { type: 'putStone'; pos: number; id: string } | { type: 'ended' }
      ) => {
        if (msg.type == 'putStone') {
          gw.send('putStone', {
            pos: msg.pos,
            id: msg.id,
          });
        } else if (msg.type == 'ended') {
          gw.dispose();

          this.onGameEnded(game);
        }
      }
    );

    // ゲームストリームから情報が流れてきたらそのままバックエンドプロセスに伝える
    gw.addListener(
      '*',
      (message: { type: string; body: { key?: string; value?: unknown } }) => {
        ai.send(message);

        if (message.type === 'updateSettings') {
          if (message.body.key === 'canPutEverywhere') {
            if (message.body.value === true) {
              gw.send('ready', false);
            } else {
              gw.send('ready', true);
            }
          }
        }
      }
    );
    //#endregion

    // どんな設定内容の対局でも受け入れる
    setTimeout(() => {
      gw.send('ready', true);
    }, 1000);
  }

  protected onDispose(): void {
    for (const backend of this.backends) {
      try {
        backend.kill();
      } catch {
        // 既に終了している場合は無視
      }
    }
    this.backends.clear();
  }

  @bindThis
  private onGameEnded(game: ReversiGame) {
    const user = game.user1Id == this.ai.account.id ? game.user2 : game.user1;

    //#region 1日に1回だけ親愛度を上げる
    const today = getDate();

    const friend = new Friend(this.ai, { user: user });

    const data = friend.getPerModulesData(this);

    if (data.lastPlayedAt != today) {
      data.lastPlayedAt = today;
      friend.setPerModulesData(this, data);

      friend.incLove();
    }
    //#endregion
  }
}
