# 藍 (lqvp/ai) リファクタリング提案書

> 調査日: 2026-10-21 / 対象コミット: `8c725df`
> 調査範囲: `src/**/*.ts` 74ファイル・15,717行の全読 + `tsc` / `biome` / 実行時再現
> 目的: **挙動を変えずに**、変更しやすさ・壊れにくさ・テストしやすさを上げる

---

## 実装状況（2026-10-22 時点）

本提案の P0 と R1〜R13 は、このブランチで **すべて実装済み**（一部は意図的に範囲を調整）。
以下は最終状態のサマリ。

### 品質ゲート

| ゲート | 結果 |
|---|---|
| `pnpm typecheck`（src + tests、`noUnusedLocals` / `noUnusedParameters` 有効） | ✅ 0 エラー |
| `pnpm build`（`tspc`） | ✅ 成功 |
| `pnpm test`（vitest） | ✅ 20 ファイル / 92 テスト |
| `pnpm lint:ci`（biome） | ✅ 132 ファイル clean |
| CI / Docker | ✅ GitHub Actions + frozen lockfile |

### 項目別

| 項目 | 状態 | 主な変更 |
|---|---|---|
| P0-1 ビルド | ✅ | `ts-patch 3.3.0` + `typescript 5.9.3`、`tspc` が通る |
| P0-2 アップロード | ✅ | `got.post(url, opts)` に修正、`retry 0`、グローバル `FormData`/`File` |
| P0-3 Base64 | ✅ | `Buffer.from(await got(...).buffer())` 相当に修正 |
| P0-4 フック隔離 | ✅ | メンション / コンテキスト / タイマーごとに try/catch、`unhandledRejection` 監視 |
| P0-5 update-checker | ✅ | `timeoutCallback` を返す + `isNewerVersion` を共通化 |
| R1 品質ゲート | ✅ | lockfile、CI、Dockerfile、vitest、biome |
| R2 設定 | ✅ | `config/schema.ts`（純粋な検証）+ `config/index.ts`（読込・シングルトン・Proxy）。import 時の I/O と `process.exit` を排除。旧 `[http]/[websocket]` を移行 |
| R3 モジュール基盤 | ✅ | `getHooks()` 自動登録、`dispose()`/`onDispose()`/`every()`/`later()`、無効時 `false` |
| R4 共通サービス | ✅ | `services/{errors,clock,logger,relationship,reaction,media,upload}`、`http/client.ts` |
| R5 Message/Friend | ✅ | `MessageSource` の判別共用体、`FriendRepository` の upsert で重複防止、返信ファイル型を `{id}` に |
| R6 aichat | ✅ | index 2,067→484 行。`prompt-builder` / `providers/{gemini,openai}` / `tools` / `chat-handler` / `auto-note` / `url-context` / `history-repository` に分割 |
| R7 earthquake | ✅ | 1,193→510 行。`format` / `validation` / `socket`（再接続 + ハートビートを共通化）に分割 |
| R8 画像・描画 | ✅ | `utils/font` / `utils/canvas` / `services/upload`。imagen 507→164 行（+`api.ts`）、veo 248→124 行（+`client.ts`、50MB 上限） |
| R9 weather/info | ✅ | weather を `index/format/api/types` に、info を `index/format/gc` に分割 |
| R10 データ層 | ✅ | `ChatHistoryRepository` 追加、インデックス整理、autosave 5 秒、`logWaking` 5 分、`stop()` で保存 + close、`meta.schemaVersion` マイグレーション |
| R11 テスト | ✅ | 20 ファイル / 92 テスト（純関数・リポジトリ・設定・整形・パース・HTTP multipart） |
| R12 依存整理 | ✅ | axios / node-cron / dayjs / uuid / memory-streams / formdata-node を除去。`Clock` と `later()` に置換 |
| R13 その他 | ✅ | `modules/registry.ts`、README 更新、docs 移動、reversi の子プロセス kill、stream のバッファ上限 + JSON ガード、`APIClient.post` の非破壊化、serifs の `deepMerge` テスト |

### 意図的に残したもの

- `index.html`（JSON/YAML→TOML 変換ツール）は GitHub Pages から配信されている可能性があるため、ルートに残した。移行期間の終了後に `docs/` へ移すか削除する。
- `Message` の `perModulesData` は既存の `getPerModulesData` API を維持（破壊的変更を避けるため）。
- 地震の「投稿（reporter）」は状態（`activeEvents` / 接続ID）と密結合しているため `index.ts` に残した。WebSocket 接続と整形・検証は分離済み。
- `index.html` 以外の設定スキーマの二重管理は解消（`config/schema.ts` が唯一のスキーマ）。

---

## 0. 結論

**全面書き換えは不要。** `APIClient` / `DatabaseManager` / `TimerManager` の分離、描画処理とロジックの分離、セリフのTOML外部化など、リファクタリングの土台はすでにできています。問題は「土台の上に載っている部分」に集中しています。

特に効くのは次の5点です。

1. **ビルドと実行が壊れている**（`tspc` のバージョン非互換、`got 15` のAPI変更）
2. **設定が検証されず、 import 時の副作用でテスト不能**（`config.ts`）
3. **モジュールにライフサイクルがなく、フック例外も隔離されていない**（`ai.ts` / `module.ts`）
4. **2,000行超のモジュールに複数の責務が同居**（`aichat` 2,067行、`earthquake_warning` 1,193行）
5. **テストが0件で、`pnpm test` も実質動かない**

進める順序は **「足場 → 欠陥 → 基盤 → 大型分割 → データ層」**。最初の1〜2週間で効果が出るのは **R1〜R4** です。aichat/earthquake の分割（R6/R7）はその後で十分間に合います。

### 0.1 今日やるべきこと（P0）

| # | 内容 | 根拠 |
|---|---|---|
| P0-1 | `ts-patch` / `typescript` の組み合わせを直し、`pnpm build` を通す | `ts-patch 4.0.1` は TypeScript >= 6 を要求。現状 5.9.3 |
| P0-2 | `APIClient.upload()` の `got.post({ url })` を `got.post(url, options)` に修正 | got 15 で同期例外。全アップロードが失敗 |
| P0-3 | `url2base64` を `Buffer.from(await got(url).buffer())` に修正 | got 15 の `.buffer()` は `Uint8Array`。`toString('base64')` が `"104,101,..."` を返す |
| P0-4 | メンションフックを try/catch で隔離し、`unhandledRejection` を監視 | 1モジュールの例外で後続フックが全部止まる |
| P0-5 | `update-checker` が `timeoutCallback` を返すように修正 | タイマーだけ登録され、コールバック未登録で毎回捨てられる |

### 0.2 1週間以内

- R1 品質ゲート（CI / lockfile / `biome ci` / `typecheck` / テストランナー）
- R2 設定ローダの純化（import 副作用と `process.exit` の排除、スキーマ検証）
- P0 の残り（`Message` の未処理 Promise、`TimerManager` のコールバック例外、設定テンプレートの不整合）

### 0.3 1ヶ月以内

- R3 モジュール基盤（`Module<T>` / ライフサイクル / `every()` / フック登録）
- R4 共通サービス（`isFollowing` / `isMaster` / `react` / 日付 / ログ / HTTP）
- R5 `Message` / `Friend` の型整理
- R11 テストの第一弾（純関数50件程度）

### 0.4 四半期

- R6 aichat 分割 + AI Provider 抽象化
- R7 earthquake_warning 分割
- R8 画像・レンダリング共通化
- R9 weather / info の分割
- R10 データ層の境界整理

### 0.5 提案一覧

| ID | 提案 | 主な効果 | 工数 | 優先度 |
|---|---|---|---|---|
| R1 | 品質ゲート（CI / lockfile / biome / typecheck） | デグレを検出できる | S | 最優先 |
| R2 | 設定ローダ + 検証 + 既定値 | テスト可能・設定ミスが起動時に分かる | M | 高 |
| R3 | Module のライフサイクル + 型 + フック自動登録 | 停止可能・フック漏れ防止 | M〜L | 高 |
| R4 | 共通サービス（relationship / reaction / clock / logger / http） | 重複削減・挙動統一 | M | 高 |
| R5 | Message / Friend の型整理 | 型安全・重複ドキュメント防止 | M | 中 |
| R6 | aichat 分割 + AI Provider 抽象化 | 2,067行の解消・プロバイダ追加容易化 | L | 中 |
| R7 | earthquake_warning 分割 | 1,193行の解消・接続ロジック共通化 | L | 中 |
| R8 | 画像・レンダリング共通化 | フォント/アップロードの重複解消 | M | 中 |
| R9 | weather / info 分割 | 責務分離・import副作用除去 | M | 中 |
| R10 | DB リポジトリ + autosave 調整 | 永続化の安全性・将来の移行 | M | 中 |
| R11 | テスト導入 | リファクタリングの安全網 | S+ | 高 |
| R12 | 依存関係の整理 | 軽量化・再現性 | S | 低 |
| R13 | その他の整理 | 可読性 | S | 低 |

---

## 1. 現状把握

### 1.1 規模

| 領域 | 行数 | 備考 |
|---|---:|---|
| コア（`ai.ts` / `index.ts` / `module.ts` / `message.ts` / `friend.ts` / `stream.ts` / `config*.ts` / `decorators.ts`） | 1,811 | `ai.ts` 511行 |
| モジュール（`src/modules/**`） | 11,496 | 34モジュール |
| ユーティリティ（`src/utils/**`） | 837 | |
| データ（`serifs.ts` / `vocabulary.ts`） | 1,143 | セリフ・語彙 |
| インフラ（`APIClient` / `DatabaseManager` / `TimerManager` / `misskey/*`） | 430 | |
| **合計** | **15,717** | |

モジュールのフック利用状況:

- `mentionHook`: 23モジュール
- `contextHook`: 5モジュール
- `timeoutCallback`: 5モジュール
- `setInterval` を使うモジュール: 16モジュール
- `setTimeout` を使うモジュール: 14モジュール

### 1.2 実行時の流れ

```
index.ts
  └─ 藍(account, modules)
       ├─ APIClient
       ├─ DatabaseManager (Loki autoload → run())
       ├─ TimerManager (1秒ごとに期限切れタイマーを走査)
       ├─ Stream (WebSocket / shared connections)
       ├─ Module.init() → install() → { mentionHook, contextHook, timeoutCallback }
       └─ onReceiveMessage(msg)
            ├─ context があれば contextHook（1モジュールのみ）
            ├─ なければ mentionHooks を優先順に実行
            └─ リアクション（reaction-config の設定を見る）
```

### 1.3 良い点（壊さないこと）

- `Module` という共通基底があり、機能追加の単位が明確。
- `context` と永続タイマー（`timers` コレクション）で「返信待ち」「リマインダー」をプロセス再起動後も維持できる。
- `chart/render-chart`、`maze/gen-maze`、`maze/render-maze`、`kiatsu/render-kiatsu` のように、描画とドメインロジックが分かれている箇所はそのまま活かせる。
- `reversi/engine.ts`、`aichat/tool-call-parser.ts`、`utils/japanese.ts`、`utils/or.ts` などは純関数に近く、テストの第一弾に向く。
- `serifs.toml` / `vocabulary.ts` により、文言とロジックが分離されている。
- `strict: true`、Biome、pnpm、Docker、Renovate が既に導入されている。

### 1.4 品質メトリクス（このチェックアウトで再現）

| 指標 | 結果 | コマンド |
|---|---:|---|
| TypeScript 型エラー | **3** | `npx tsc --noEmit` |
| ビルド | **失敗** | `npx tspc --noEmit` |
| Biome lint（`pnpm lint` 相当） | **0**（実質無効） | `npx biome lint src` |
| Biome check（lint + format + import整理） | **51**（import整理47 + format4） | `npx biome check src` |
| 未使用の import / 変数 / 引数 | **17** | `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` |
| `noImplicitAny` を有効にした場合 | **134** | `npx tsc --noEmit --noImplicitAny` |
| `any` 系の記述 | **約122** | `grep -rn ": any\|<any>\|as any" src` |
| `console.*` | **42** | `grep -rn "console\." src` |
| テストファイル | **0** | `find src -name "*.test.ts"` |
| lockfile | **なし** | `ls pnpm-lock.yaml` |
| `biome.json` の `recommended` | **false** | `biome.json:18` |

> `biome lint` が0件なのは、`biome.json` で `linter.rules.recommended: false` になっており、実質的にlintルールが無効なためです。`biome check` では51件出ます。

---

## 2. リファクタリング以前に直すべき欠陥（P0）

これらは「リファクタリング」ではなく不具合修正です。先に直さないと、以降の変更を検証できません。

### 2.1 ビルドが通らない

**症状**

```
$ npx tspc --noEmit
PatchError: ts-patch v4 requires TypeScript >= 6. Found 5.9.3.
Use the previous ts-patch major for older TypeScript versions.
```

`package.json` は `typescript: 5.9.3` と `ts-patch: 4.0.1` を固定しており、両者が非互換です。`pnpm build` は `tspc` なので、クリーンな環境ではビルドできません。

さらに `tsc --noEmit` でも3件の型エラーがあります。

```
src/api/APIClient.ts(46,11): error TS2769: ... 'url' does not exist in type 'StreamOptions'
src/modules/veo/index.ts(168,7): error TS2740: Type 'Uint8Array' is missing ... from type 'Buffer'
src/utils/url2base64.ts(7,40): error TS2554: Expected 0 arguments, but got 1
```

**修正案**

1. 短期: `ts-patch` を TypeScript 5.x 対応の 3.x に固定する（または TypeScript 6 系へ上げる）。
2. 中期: `ts-patch` + `typescript-transform-paths` をやめ、**Node の subpath imports**（`package.json` の `imports`）か `tsc-alias` に寄せる。パス変換プラグインはビルドを壊しやすい上、テストランナーとも相性が悪い。
3. `package.json` に `packageManager` と `engines` を追加し、pnpm のバージョンを固定する。
4. `pnpm-lock.yaml` をコミットする（現状 lockfile がなく、依存解決が再現しない）。
5. Dockerfile の `pnpm install && pnpm run build || test -f ./built/index.js` は失敗を握りつぶすので、`pnpm install --frozen-lockfile && pnpm build` に変える。

**規模/リスク**: S / 低。ここが赤いままでは他の改善をCIで守れません。

---

### 2.2 アップロードと画像入力が実行時に壊れている

**症状1: `APIClient.upload()` が同期例外**

```ts
// src/api/APIClient.ts:44-51
const res = await got
  .post({
    url: `${config.apiUrl}/drive/files/create`,
    body: form,
    headers: { ... },
  })
  .json();
```

got 15 では options オブジェクト内の `url` はサポートされません。実行すると:

```
The `url` option is not supported in options objects. Pass it as the first argument instead.
```

**影響**: `ai.upload()` を使うすべての機能（チャート、迷路、気圧画像、imagen、veo など）が失敗します。

**修正**:

```ts
const res = await got
  .post(`${config.apiUrl}/drive/files/create`, {
    body: form,
    headers: { 'User-Agent': this.getDefaultUserAgent() },
  })
  .json();
```

**症状2: `url2base64` が base64 を返していない**

```ts
// src/utils/url2base64.ts:6-7
const buffer = await got(url).buffer();
const base64File = buffer.toString('base64');
```

got 15 の `.buffer()` は `Uint8Array` を返します。`Uint8Array#toString()` は引数を取らず、`"104,101,108,108,111"` のようなカンマ区切り文字列を返します。

実際にローカルHTTPサーバーで確認:

```
constructor: Uint8Array isBuffer: false
toString(base64): "104,101,108,108,111"
```

**影響**: aichat の引用画像・添付画像、imagen の入力画像が不正な base64 として Gemini に送られます（APIエラーまたは無視）。

**修正**:

```ts
const bytes = await got(url, { timeout: { request: 30_000 } }).buffer();
return Buffer.from(bytes).toString('base64');
```

**再発防止**: `utils/url2base64` に「ローカルHTTPサーバーから `hello` を取得すると `aGVsbG8=` を返す」テストを追加する。got をモックせず実際のHTTPで検証できるのが望ましい。

**規模/リスク**: XS / 低。ただし影響範囲は広い。

---

### 2.3 フックの例外が隔離されていない

**症状**

```ts
// src/ai.ts:301-303
for (const handler of this.mentionHooks) {
  res = await handler(msg);
  if (res === true || typeof res === 'object') break;
}
```

- 1つの `mentionHook` が throw すると、**後続のモジュールは一切実行されない**。
- `onReceiveMessage()` はストリームのイベントハンドラから `await` されずに呼ばれるため、例外は未処理 rejection になる。
- `this.contextHooks[context.module]` が `undefined` の場合（例: 起動時に無効化されたモジュールの context がDBに残っている）、`handler(...)` で TypeError。
- `TimerManager` のコールバックも try/catch なし（`TimerManager.ts:99`）。
- `Message` コンストラクタの `users/show` は `.then()` のみで `.catch()` がない（`message.ts:82-88`）。
- モジュール内の `this.ai.post()` / `msg.reply()` は35箇所中23箇所が await されておらず、失敗がログに残りにくい。

**影響**: 1つのモジュールのバグで、そのメッセージに対する全機能が停止。投稿失敗も「何も起きない」ように見える。`index.ts:57-63` の `uncaughtException` ハンドラはログを出すだけで、発生元もわかりにくい。

**修正の方向**

1. フックを `{ module, handler }` で保持し、1件ずつ try/catch。失敗したモジュール名をログに出す。
2. context hook が存在しない場合はログを出して mention hooks にフォールバック。
3. `TimerManager` のコールバックを try/catch し、1つのタイマー失敗で監視ループを止めない。
4. `Message` の `users/show` は `.catch()` を付け、失敗時はストリーム付属のユーザー情報のまま継続。
5. `process.on('unhandledRejection')` を追加し、少なくともスタックと発生元を記録する。
6. 投稿系は `safePost()` / `safeReply()` のようなヘルパーに寄せ、`void promise.catch(logger.error)` を統一する。

**コードイメージ**

```ts
// src/ai.ts
private async invokeMentionHooks(msg: Message): Promise<HandlerResult> {
  for (const { module, handler } of this.mentionHooks) {
    try {
      const res = await handler(msg);
      if (res === true || typeof res === 'object') {
        return typeof res === 'object' ? res : {};
      }
    } catch (err) {
      this.logger.error(`[${module}] mention hook failed`, { err, msgId: msg.id });
    }
  }
  return {};
}
```

```ts
const handler = this.contextHooks[context.module];
if (!handler) {
  this.logger.warn(`context module not installed: ${context.module}`);
  return this.invokeMentionHooks(msg);
}
```

**規模/リスク**: S / 低。挙動は「失敗しても次へ進む」方向にのみ変わる。

---

### 2.4 `update-checker` が永久に動かない

```ts
// src/modules/update-checker/index.ts:20-31
public install(): InstallerResult {
  ...
  this.setTimeoutWithPersistence(60 * 1000, { immediate: true });
  return {};   // ← timeoutCallback を返していない
}

public async timeoutCallback(data?: any) { ... }
```

`Ai.run()` は `install()` の戻り値の `timeoutCallback` だけを `TimerManager` に登録します。したがって:

1. 起動時にタイマーが1件挿入される
2. 60秒後に `TimerManager` が期限切れを検出
3. `timeoutCallbacks['update-checker']` が undefined なので警告して終了
4. `timeoutCallback` 内の再スケジュールも実行されない

さらに `isNewer()` は文字列比較なので、`3.10.0` を `3.9.0` より古いと判定します。

**修正**: `return { timeoutCallback: this.timeoutCallback };` に変更。`isNewer` は数値配列比較に置き換え、テストを追加。

**根本原因**: `install()` の戻り値にフックを手で書く契約が壊れやすい。R3 で「基底クラスがフックを自動登録する」形に変える。

---

### 2.5 その他の小さな欠陥（ついでに直す）

| 箇所 | 症状 | 修正 |
|---|---|---|
| `ai.ts:151-156` | `if (data.text && ...)` の内側で `if (data.text == null)` を判定しており、到達不能。非公開扱いの投稿を取得する分岐が死んでいる | 外側の条件を外し、`text` が null なら `notes/show` してから判定 |
| `ai.ts:160-167` | 同上（reply） | 同上 |
| `message.ts:82-88` | メッセージごとに `users/show` を1回呼ぶ。しかも catch なし | ユーザー情報が欠けている場合のみ取得。catch 追加 |
| `reminder/index.ts:197` | `err.statusCode === 400` を見ているが、got のエラーは `err.response.statusCode` | `getHttpStatus(err) === 400` に変更 |
| `info/index.ts:534` | `uninstall()` が定義されているが、基底クラスにも呼び出し側にも存在しない | R3 で `dispose()` を基底に追加し、終了時に呼ぶ |
| `info/index.ts:594` | `this.ai.modules.sort(...)` が配列を破壊的に並べ替える | `[...this.ai.modules].sort(...)` |
| `guessing-game/index.ts:35-49` | `exist` を取得しているが使わず、常に新しいゲームを insert。同時に複数ゲームが開始できる | `if (exist) { msg.reply(...); return true; }` |
| `follow/index.ts:453` | `fetchAllUsers` が `while (true)` で上限なし。APIが同じページを返し続けると無限ループ | `maxPages` と `untilId` の前回値チェック |
| `earthquake_warning/index.ts:464-475` | `heartbeatTimeoutMs` / `heartbeatIntervalMs` の設定を無視して 120000/60000 をハードコード | `config.earthquakeWarning?.heartbeatTimeoutMs ?? 120000` |
| `example.config.toml:19-23` | `[http] userAgent` / `[websocket] userAgent` は `config.http.userAgent` になり、コードが読む `config.userAgent.http` と一致しない。UA設定が黙って無視される | テンプレートを `[userAgent] http=... websocket=...` に変更 |
| `check-custom-emojis/index.ts:169` | ローカルの `sleep()` が `utils/sleep.ts` と重複 | 共通関数に置換 |
| `utils/get-date.ts` | ローカルタイムの `Y/M/D`。`birthday` は `MM-DD`、`chart` は `Y-M-D` と形式がバラバラ | R4 の `date` ユーティリティに統一 |

---

## 3. リファクタリング提案

各提案は「ねらい / 現状 / 提案 / 効果 / 規模・リスク」でまとめます。規模は概算の作業量です（S: 半日〜2日、M: 3〜5日、L: 1〜2週間）。

---

### R1. 品質ゲートと足場を作る

**ねらい**: 以降の変更をCIで守れる状態にする。

**現状**

- `.github/workflows` は Docker build と release のみ。lint / typecheck / test のCIがない。
- `pnpm lint` は `biome lint src --write`。`recommended: false` なのでほぼ何も検査せず、CIで使うとファイルを書き換える。
- `pnpm test` は `node --test` だが、テストファイルが0件。TSテストを置いても `.js` import の解決でそのままでは動かない。
- lockfile がない。
- `.editorconfig` は `indent_style = tab`、`biome.json` は `indentStyle: space`。設定が矛盾している。

**提案**

1. `.github/workflows/ci.yml` を追加:

```yaml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint:ci
      - run: pnpm test
      - run: pnpm build
```

2. `package.json` にスクリプト追加:

```json
"typecheck": "tsc --noEmit",
"lint:ci": "biome ci src",
"lint": "biome check src --write",
"test": "vitest run"
```

3. `biome.json` の `recommended` を `true` にし、一度に全部直さない。まず以下だけ有効化して自動修正:

- `correctness.noUnusedImports`
- `correctness.noUnusedVariables`
- `suspicious.noDoubleEquals`
- `style.useConst`
- `style.useTemplate`
- `complexity.useOptionalChain`
- `suspicious.noExplicitAny` / `style.noNonNullAssertion` は**後回し**（現状 `off` になっている）

4. `noUnusedLocals` / `noUnusedParameters` を有効化（17件の修正は機械的）。
5. `.editorconfig` と `biome.json` のインデントを統一する（現状のコードはスペース2が多数派なので、`space` に寄せるのが現実的）。
6. `pnpm-lock.yaml` をコミットし、`packageManager: "pnpm@..."` を追加。

**効果**: デグレをCIで検出できる。レビューでフォーマットの指摘が消える。依存解決が再現する。

**規模/リスク**: S / 低。最初のPRは「設定追加 + 自動修正のみ」に限定し、ロジック変更を混ぜない。

---

### R2. 設定を「純粋なローダ + 検証 + 既定値」に分ける

**ねらい**: import しただけで `process.exit` する状態をやめ、設定ミスを起動時に分かるようにする。

**現状**

```ts
// src/config.ts:142-150
import { performStartupConfigCheck } from './config-updater.js';

export const config = performStartupConfigCheck(); // ← import時にファイルI/O + process.exit

config.wsUrl = config.host.replace('http', 'ws');
config.apiUrl = config.host + '/api';
export default config as Config;
```

- `config.ts` を import する全モジュールが、テスト時にも `./config.toml` を要求する。
- `config-updater.ts` に `Config` 型が**もう1つ**定義されている（`config-updater.ts:4-8`）。
- 検証は「テンプレートにないキー」の検出のみ。型・範囲・必須チェックはない。
- `as Config` でキャストしており、`[http] userAgent` のような構造ミスを検出できない。
- `config.wsUrl = config.host.replace('http', 'ws')` は `new URL` を使わない文字列置換で、スキームや末尾スラッシュの扱いが雑。`apiUrl` も `host + '/api'` なので、`host` が `/` で終わると二重スラッシュになる。
- 既定値が各モジュールに散らばっている（`?? 10000`, `?? 120000`, `?? 2` など）。同じ設定でも `undefined` の扱いが `=== false` と `!value` で異なる。
- `configVersion` は未使用。

**提案**

```
src/config/
  schema.ts      # Config 型 + 既定値 + バリデーション
  load.ts        # loadConfig(path): Config（純粋、I/Oのみ）
  index.ts       # 起動時に一度だけ初期化するシングルトン
```

- `loadConfig(path)` は `Config` を返すか `ConfigError` を投げるだけ。`process.exit` は呼ばない。
- `src/index.ts`（composition root）で:

```ts
try {
  initConfig(loadConfig(process.env.AI_CONFIG ?? './config.toml'));
} catch (err) {
  logger.error('設定ファイルが不正です', err);
  process.exit(1);
}
```

- `initConfig` は既存の `config` オブジェクトを `Object.assign` で埋める。これにより、既存の `import config from '@/config.js'` を一気に書き換えずに副作用だけ除去できる。
- **モジュールのトップレベルで config を読んでいる箇所を遅延化**する:
  - `aichat/index.ts:184-185` の `geminiModel` / `GEMINI_API`
  - `weather/index.ts:18-19` の `DEFAULT_WEATHER_PLACE` / `DEFAULT_AUTO_NOTE_HOUR`
  - `earthquake_warning/index.ts` のインスタンスフィールド（コンストラクタ時ならOKだが、明示的に getter へ）
- 検証項目:
  - `host` が URL として妥当、末尾スラッシュを正規化
  - `i` が非空
  - `master` が存在する場合の形式
  - `gemini.autoNote.probability` が 0〜1、`intervalMinutes > 0`
  - `nightHours.start/end` が 0〜23
  - `kiatsu` / `earthquakeWarning` の各 ms が正の数
  - `jina.search.maxResults` / `exa.search.maxResults` が 1〜5
  - `updateChecker.repository` が `owner/repo` 形式
- 既定値は `schema.ts` の1箇所に集約し、モジュール側の `??` を削除する。
- 設定テンプレートは起動時に読まず、`example.config.toml` はドキュメントとして維持。テンプレートとの差分チェックはテストで行う。

**コードイメージ**

```ts
// src/config/schema.ts
export type Config = {
  host: string;
  i: string;
  master?: string;
  userAgent?: { http?: string; websocket?: string };
  gemini: {
    enabled: boolean;
    apiKey?: string;
    model: string;
    autoNote: { probability: number; intervalMinutes: number };
  };
  // ...
};

export function resolveConfig(raw: RawConfig): Config {
  return {
    ...raw,
    host: normalizeHost(raw.host),
    gemini: {
      enabled: raw.gemini?.enabled ?? false,
      model: raw.gemini?.model ?? 'gemini-2.5-flash',
      apiKey: raw.gemini?.apiKey,
      autoNote: {
        probability: clamp(raw.gemini?.autoNote?.probability ?? 0.02, 0, 1),
        intervalMinutes: Math.max(1, raw.gemini?.autoNote?.intervalMinutes ?? 360),
      },
    },
  };
}
```

**効果**: テストが `config.toml` なしで動く。設定ミスが「黙って無視」ではなく起動時に明確なエラーになる。既定値の散在がなくなる。

**規模/リスク**: M / 中。`config` の参照箇所が多いため、まず「副作用除去 + 既定値集約」だけを行い、DI化は別PRにする。

---

### R3. モジュール基盤にライフサイクルと型を与える

**ねらい**: 「install したら止められない」「フックの登録漏れが起きる」「getData が any」を解消する。

**現状**

```ts
// src/module.ts
private doc: any;
protected getData() { return this.doc.data; }
protected setData(data: any) { ... }
```

- `getData` / `setData` が any。`chart` などは `(data as any).lastPosted` とキャストしている。
- `install()` の戻り値にフックを手書きする契約。`update-checker` のように漏れる。
- `uninstall()` を定義しているモジュールがある（`info`）が、基底・呼び出し側にない。
- 16モジュールが `setInterval` を直接呼び、ハンドルを保持していない。終了時に止められず、テストでも開きっぱなしになる。
- 非同期の `setInterval` コールバックが重複実行されうる（`chart.post`、`maze.post`、`weather` など）。
- `moduleData` の `findOne({ module: name })` にユニーク制約がなく、重複ドキュメントができる可能性。

**提案（段階的）**

**Step 1（低リスク・すぐ効く）**

- 基底に `dispose()` を追加し、`Ai.stop()` から全モジュールに呼ぶ。
- 基底に以下を追加:

```ts
private readonly disposers = new Set<() => void>();

protected every(ms: number, task: () => void | Promise<void>): void {
  let running = false;
  const id = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (err) {
      this.log(`interval task failed: ${err}`);
    } finally {
      running = false;
    }
  }, ms);
  this.disposers.add(() => clearInterval(id));
}

protected later(ms: number, task: () => void | Promise<void>): void { ... }

public dispose(): void {
  for (const dispose of this.disposers) dispose();
  this.disposers.clear();
}
```

- 既存の `setInterval` を `this.every(...)` に置き換える（機械的）。
- `Ai` に `stop()` を追加し、SIGTERM / SIGINT で `connection.close()`、`timerManager.stopMonitoring()`、`module.dispose()`、`db.close()` を実行。

**Step 2（型付け）**

```ts
export default abstract class Module<
  TData extends Record<string, unknown> = Record<string, unknown>,
> {
  private doc!: LokiDoc<TData>;
  protected getData(): TData { return this.doc.data; }
  protected setData(data: TData): void { ... }
}
```

- `chart` は `Module<{ lastPosted?: string }>`、`maze` も同様に。
- `moduleData` コレクションに `module` のユニークインデックスを追加。既存の重複は起動時に検出してログ。

**Step 3（フック登録の自動化）**

- `InstallerResult` を返す `install()` を、`getHooks()` に置き換える（または併用）。

```ts
export abstract class Module<TData> {
  public getHooks(): InstallerResult {
    return {
      mentionHook: this.onMention?.bind(this),
      contextHook: this.onContext?.bind(this),
      timeoutCallback: this.onTimeout?.bind(this),
    };
  }

  protected onMention?(msg: Message): Promise<boolean | HandlerResult>;
  protected onContext?(key: string, msg: Message, data?: unknown): Promise<void | boolean | HandlerResult>;
  protected onTimeout?(data?: unknown): void;
}
```

- 各モジュールは `mentionHook` → `onMention` にリネームするだけ。`update-checker` のような漏れが構造的に起きなくなる。
- 移行期間中は `Ai` が `install()` の戻り値と `getHooks()` をマージしてもよい。

**Step 4（フックの実行）**

- `mentionHooks` を `{ module: string; handler: MentionHook }[]` に。
- 例外隔離（P0-4）、context hook の存在チェック、`reaction` / `immediate` の正規化を `Ai` から `MessageRouter` に抽出。

**効果**: モジュールの追加・削除・停止が安全になる。テストで `dispose()` 後に開いているハンドルがないことを確認できる。`any` が減る。

**規模/リスク**: M（Step 1-2）、L（Step 3-4）。Step 1 だけでも先に出す価値がある。

---

### R4. 共通サービスを抽出する（重複の除去）

**ねらい**: 同じ処理が3〜7箇所にある状態をやめ、修正を1箇所にする。

**現状の重複一覧**

| 処理 | 箇所 | 備考 |
|---|---|---|
| `isFollowing(userId)` | `aichat:1422`, `imagen:103`, `veo:63` | 3コピー。`users/relation` の呼び方も同じ |
| マスターユーザー判定 | `follow:42`, `aichat:1441`, `info:567`（インライン） | `username === config.master && host === null` |
| リアクション作成 | `ai.ts:180`, `ai.ts:341`, `emoji-react:39`, `imagen:526`, `ping:43`, `veo:224`, `welcome:26` | 7箇所。`shouldReaction` の扱いもバラバラ |
| ノートの添付ファイル → Base64 | `aichat:1312`（現在ノート）, `aichat:1362`（引用）, `imagen:300`, `imagen:375` | 4コピー。ログ文言だけ違う |
| Google 生成AI API 呼び出し + 型 + エラー整形 | `aichat:343/825`, `imagen:120/244`, `veo:80` | 3モジュールに型定義が重複 |
| 日次スケジュール（毎時チェック） | `chart:17/27`, `maze:18/28`, `check-custom-emojis:24/34`, `birthday:16`, `valentine:12`, `weather:358` | 6箇所。日付キーの形式もバラバラ |
| 日付キー | `chart:28` (`Y-M-D`), `maze:29`, `check:35`, `valentine:27`, `birthday:31` (`MM-DD`), `get-date` (`Y/M/D`) | 形式がバラバラ（`Y-M-D` / `Y/M/D` / `MM-DD` など） |
| 地名解決 | `weather:397-403`, `weather:455-461` | 完全に同じブロック |
| キャンバス生成 / フォント初期化 | `chart/render-chart:29`, `kiatsu/render-kiatsu:46`, `maze/render-maze` | chart は毎回 `GlobalFonts.registerFromPath`。maze はフォント未使用 |
| Exa / Jina の検索ラッパ | `utils/exa.ts`, `utils/jina.ts` | `clampMaxResults` / `formatError` がほぼ同一 |
| 画像アップロード | `imagen:454`, `veo:176` | MIME→拡張子、`ai.upload` の呼び方 |
| HTTP クライアント | `got` 12ファイル、`axios` 2ファイル | タイムアウト・UA・エラー形式がバラバラ |
| ユーザー表示文字列 | `utils/acct.ts`, `utils/user-formatter.ts`, `follow:97` | `@user@host` の組み立てが3種類 |
| ページネーション | `follow:453`, `check-custom-emojis:100-135` | どちらも `while(true)` 系 |

**提案**

```
src/services/
  relationship.ts   # isFollowing / isMaster / getRelation
  reaction.ts       # react(noteId, reaction) / canReact(friend)
  media.ts          # noteFilesToBase64() / uploadBuffer() / mimeToExt()
  scheduler.ts      # dailyAt(hour, key, task) / every(ms, key, task)
  clock.ts          # now(), todayKey(), formatDate()
  logger.ts         # debug/info/warn/error + child(scope)
  errors.ts         # toError(), getHttpStatus(), formatApiError()
src/http/
  client.ts         # getJson / postJson / getBuffer（got を1箇所に）
  search.ts         # Exa / Jina の共通 clamp + 結果整形
```

**各サービスの形**

```ts
// services/relationship.ts
export class RelationshipService {
  constructor(private api: APIClient, private accountId: string) {}
  async isFollowing(userId: string): Promise<boolean> { ... }
  isMaster(user: User): boolean { ... }
}

// services/reaction.ts
export class ReactionService {
  constructor(private api: APIClient) {}
  async react(noteId: string, reaction: string): Promise<void> {
    await this.api.api('notes/reactions/create', { noteId, reaction });
  }
}

// services/scheduler.ts
export class Scheduler {
  constructor(private clock: Clock, private store: KeyValueStore) {}
  dailyAt(key: string, hour: number, task: () => Promise<void>): void { ... }
}
```

**日付の統一**

- `Clock` は `Asia/Tokyo` を既定にし、`todayKey()` は `YYYY-MM-DD` を返す。
- 既存の `Y-M-D` / `Y/M/D` / `MM-DD` は移行期間中だけ読み替えを許容し、次のリリースで統一。
- `getDate()` は `clock.todayKey()` に置き換え、`talk` / `reversi` / `friend` の日次制限を同じ基準にする。

**ログの統一**

- `utils/log.ts`、`Module.log`、`APIClient.log`、`TimerManager.log`、`console.*` を `Logger` に集約。
- `APIClient` は全API呼び出しを `info` で出しているが、`debug` に下げる（本番ログが埋まる）。
- エラーは `name/message/stack/code/status` を構造化して出す。

**HTTP の統一**

- `got` に寄せ、`axios` の2箇所（`kiatsu`, `weather`）を移行。
- タイムアウトを必須化し、検索系のみリトライ。`notes/create` は重複投稿を避けるため自動リトライしない。
- `got 15` の `buffer()` は `Buffer.from(await res.buffer())` を返すラッパーに閉じ込める。

**効果**: 重複が約300〜400行減る見込み。`isFollowing` の仕様変更が1箇所で済む。日付・ログ・HTTPの挙動が揃う。

**規模/リスク**: M / 中。まず `relationship` / `reaction` / `clock` / `errors` の4つから。`scheduler` は R3 の `every()` と同時に。

---

### R5. `Message` と `Friend` の型を整理する

**ねらい**: `any` と非nullアサーションを減らし、チャット/ノートの分岐を安全にする。

**現状**

- `Message` は `chatMessage: {...} | null` と `note: {...} | null` を両方持ち、getter ごとに三項演算子で分岐。`this.note!.id` のような非nullアサーションが多い。
- コンストラクタ引数が `any`。
- `text` は `string` 型だが、ノートでは `null` になりうる（`includes` 側で実行時にガードしている）。
- `reply()` の `file?: any`。
- `Friend` は Loki ドキュメントのラッパーで、`save()` が同期、`forceSetLove()` だけ `async`（実際は同期保存を await）。
- `friends` コレクションの `userId` はインデックスのみでユニークではない。同じユーザーから同時に2通来ると重複ドキュメントができる可能性。

**提案**

```ts
type MessageSource =
  | { kind: 'note'; note: Note }
  | { kind: 'chat'; chat: ChatMessage };

export default class Message {
  constructor(private ai: 藍, private source: MessageSource) {}

  get id(): string { return this.source.kind === 'note' ? this.source.note.id : this.source.chat.id; }
  get text(): string | null { ... }
  get isChat(): boolean { return this.source.kind === 'chat'; }
  get replyId(): string | null { ... }
}
```

- `reply()` の戻り値を `Promise<Note | ChatMessage>` に。
- `file` を `{ id: string }` に。
- `hasText()` または `text ?? ''` を明示し、`includes` / `or` は `string | null` を受ける。
- `friend`: `FriendRepository.getOrCreate(user)` に移し、`userId` にユニークインデックスを追加。既存重複は起動時にマージ。
- `Friend.forceSetLove` は同期化するか、`save()` を `Promise<void>` に統一する。
- `perModulesData` は `getModuleData<T>(moduleName, fallback)` の形にし、モジュール名の文字列直書きを減らす。

**効果**: `!` と `any` が減り、チャット/ノートの分岐漏れが型で検出できる。友達ドキュメントの重複が防げる。

**規模/リスク**: M / 中。`Message` は全モジュールが使うため、移行は getter の互換を保ちながら段階的に。

---

### R6. `aichat` を分割し、AI Provider を抽象化する

**ねらい**: 2,067行・23メソッドのモジュールを、テスト可能な単位に分ける。

**現状**

- `genTextByGemini`: 343〜822行（約480行）
- `genTextByOpenai`: 825〜1215行（約390行）
- `note2base64File`: 1312〜1360、`getQuotedNoteFiles`: 1362〜1420（ほぼ同一）
- `handleAiChat`: 1860〜2046（約190行）
- Gemini の型（`GeminiPart` / `GeminiContents` / `GeminiApiResponse`）が `imagen` / `veo` にも重複。
- システムプロンプト（friendName、master、fromMention、grounding、timelineContext）の組み立てが Gemini と OpenAI でほぼ同じ。
- URL・YouTube・添付ファイルの処理が両プロバイダに散在。
- ツール呼び出し（Exa / Jina）のループが OpenAI 側に密結合。

**提案する分割**

```
src/modules/aichat/
  index.ts            # install / mentionHook / contextHook / timeoutCallback のみ
  prompt-builder.ts   # system instruction + timeline + friend/master + constraints
  history.ts          # aichatHist の読み書き、履歴トリム、タイマー
  media.ts            # ノート/引用のファイル → Base64（imagen と共用）
  tools.ts            # exa_search / jina_read の定義と実行
  providers/
    types.ts          # ChatProvider / ChatRequest / ChatResponse
    gemini.ts         # generateContent、grounding、URL context、レスポンス解析
    openai.ts         # chat/completions、tool loop
```

**Provider インターフェース**

```ts
export type ChatAttachment = { mimeType: string; base64: string };

export type ChatRequest = {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  attachments?: ChatAttachment[];
  tools?: ToolDefinition[];
  grounding?: boolean;
};

export type ChatResponse = {
  text: string;
  toolCalls?: ToolCall[];
  error?: { code?: number; message: string };
};

export interface ChatProvider {
  readonly id: 'gemini' | 'openai';
  generate(req: ChatRequest): Promise<ChatResponse>;
}
```

- `prompt-builder.ts` はプロバイダ非依存の文字列を返す。Gemini 用の `contents` / OpenAI 用の `messages` への変換は各アダプタが行う。
- 技術制約・禁止事項の文言は `prompts/technical-constraints.ts` に定数化。テストでは「日時が含まれる」「master フラグが含まれる」など構造的に検証する（全文スナップショットは壊れやすい）。
- `parseGeminiResponse` を切り出し、`candidates` / `groundingMetadata` / `url_context_metadata` の分岐をテスト可能にする。
- `tools.ts` に `executeToolCall` / `executeExaSearchCall` / `executeJinaReadCall` を移し、`tool-call-parser` のテストと合わせる。
- `media.ts` は `noteFilesToBase64(noteId)` と `quotedNoteFilesToBase64(quoteId)` を1つの `extractFiles(noteId, { includeUrl })` に統合し、`imagen` からも使う。
- `history.ts` は `AiChatHist` のコレクション操作と `TIMEOUT_TIME` のタイマーを担当。`index.ts` から Loki を追い出す。

**期待するサイズ**

| ファイル | 目安 |
|---|---:|
| `index.ts` | 250〜350行 |
| `prompt-builder.ts` | 200〜300行 |
| `providers/gemini.ts` | 250〜350行 |
| `providers/openai.ts` | 200〜300行 |
| `media.ts` | 100〜150行 |
| `tools.ts` | 150〜200行 |
| `history.ts` | 80〜120行 |

**効果**: プロバイダ追加（例: Anthropic）が `providers/` の1ファイルで済む。プロンプトの変更が1箇所になる。Gemini のレスポンス解析にテストが書ける。`imagen` / `veo` と型・HTTP・エラー処理を共有できる。

**規模/リスク**: L / 中〜高。R4（HTTP / media / errors）と R11（tool-call-parser のテスト）を先に済ませると安全。**一度に全部やらず、まず media と providers/types を抽出**し、`genTextByGemini` の引数を `ChatRequest` に変えるところから。

---

### R7. `earthquake_warning` を分割する

**ねらい**: 1,193行・45メソッドのモジュールから、WebSocket 接続とメッセージ整形を分離する。

**現状**

- Wolfx 用と P2PQuake 用の2つの WebSocket クライアントが同じクラス内にあり、以下がほぼ重複:
  - 接続 / 再接続（指数バックオフ + ジッター）
  - ハートビート監視
  - `ignoreInitialData` のタイマー
  - 接続IDの生成
- メッセージ生成（`generateEarthquakeMessage` / `generateTsunamiMessage` / 初報・続報・終報・取消）が純関数なのにクラス内に閉じている。
- `activeEvents` / `lastEarthquakeData` は終報・取消で削除されるが、終報が来ないイベントは残り続ける。
- `heartbeatTimeoutMs` / `heartbeatIntervalMs` の設定が未使用（ハードコード）。
- `processedTsunamiIds` は TTL 付きで prune しているが、再起動で消える（重複投稿の可能性）。

**提案**

```
src/modules/earthquake_warning/
  index.ts            # 設定判定とクライアントの起動・停止のみ（150行以下）
  reconnecting-ws.ts  # 汎用: 再接続 + ハートビート + initial-data 無視
  wolfx.ts            # Wolfx の型・検証・イベント状態機械
  p2pquake.ts         # P2PQuake の型・検証・津波重複排除
  format.ts           # 純関数: 地震/津波のMFM生成
  events.ts           # activeEvents / lastEarthquakeData の TTL 管理
```

**`reconnecting-ws.ts` の形**

```ts
export type ReconnectingWsOptions = {
  url: string;
  heartbeat: { intervalMs: number; timeoutMs: number; send: () => void };
  reconnect: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  onMessage: (data: unknown) => void;
  onOpen?: () => void;
};

export class ReconnectingWs {
  constructor(private opts: ReconnectingWsOptions) {}
  connect(): void;
  close(): void;
}
```

- `config.earthquakeWarning.heartbeatTimeoutMs` / `heartbeatIntervalMs` をここで使う。
- `ignoreInitialData` は「接続直後 N 秒のイベントを捨てる」オプションとして汎用化。
- 再接続のバックオフ計算（`reconnectDelay * 1.5^(n-1)` + jitter）を1箇所に。

**`format.ts` は純関数にする**

```ts
export function formatEarthquakeInitial(data: WolfxEarthquakeData): string;
export function formatEarthquakeUpdate(data: WolfxEarthquakeData, event: EarthquakeEvent): string;
export function formatEarthquakeFinal(data: WolfxEarthquakeData): string;
export function formatTsunami(data: P2PQuakeTsunamiData): string;
```

- テストは固定データ → 期待するMFMの文字列（または重要な断片）で行う。
- `MaxIntensity` / `WarnArea` / `isCancel` / `isFinal` の分岐をテーブル駆動にする。

**効果**: 接続ロジックのバグ修正が1箇所で済む。地震メッセージの文言変更にテストが付く。`index.ts` が読みやすくなる。

**規模/リスク**: L / 中。外部APIの実データが必要なテストは、まず保存済みのサンプルJSONで純関数をテストする。WebSocket の統合テストは最後。

---

### R8. 画像・レンダリングの共通化

**ねらい**: フォント登録・キャンバス生成・アップロードの重複をなくす。

**現状**

- `chart/render-chart.ts:29` は `renderChart()` のたびに `GlobalFonts.registerFromPath('./font.ttf', 'CustomFont')` を呼ぶ。毎回のファイルI/O + 再登録。
- `kiatsu/render-kiatsu.ts:46` は `fontInitialized` フラグで1回だけ登録するが、フォント名・フォールバックの実装が chart と別。
- `maze/render-maze.ts` はフォントを使わないが、キャンバス生成・背景描画のパターンが似ている。
- `imagen:454` と `veo:176` の `uploadToMisskey` がほぼ同じ（MIME→拡張子、ファイル名、`ai.upload`）。
- `imagen` は「従来の Imagen API」と「Gemini 画像生成 API」の2経路を1ファイルに持つ。

**提案**

```
src/render/
  canvas.ts     # createCanvasWithBackground(width, height, color)
  font.ts       # ensureFont() / font(size, weight) / FONT_FAMILY
  upload.ts     # uploadPng(ai, buffer, prefix) / mimeToExt()
```

```ts
// src/render/font.ts
let initialized = false;
let family = 'sans-serif';

export function ensureFont(path = './font.ttf'): string {
  if (initialized) return family;
  try {
    GlobalFonts.registerFromPath(path, 'AiFont');
    family = 'AiFont';
  } catch {
    family = 'sans-serif';
  }
  initialized = true;
  return family;
}

export function font(size: number, weight: 'normal' | 'bold' = 'normal'): string {
  return `${weight} ${size}px ${ensureFont()}`;
}
```

- `render-chart` / `render-kiatsu` は `ensureFont()` / `font()` を使う。
- `imagen` は `imagen/api.ts`（2経路）と `index.ts`（フック）に分割。
- `veo` は `generateVideo` / `poll` / `download` を `veo/client.ts` に分ける。
- 動画・画像のダウンロードには最大サイズを設ける（例: 50MB）。無制限に `Buffer` を持つとメモリを圧迫する。

**効果**: フォント登録の無駄なI/Oがなくなる。画像系のアップロード修正が1箇所で済む（P0-2 の再発防止）。

**規模/リスク**: M / 低〜中。

---

### R9. `weather` と `info` を分割する

**ねらい**: 取得・整形・スケジュール・診断を分ける。

**`weather`（495行）**

- `prefMapCache` / `cityMapCache` の更新、XML/JSON の取得、地名解決、MFM 整形、日次投稿、mentionHook が同居。
- 地名解決ブロックが `397-403` と `455-461` で完全に重複。
- `install()` から `updateWeatherMaps()` / `updateCityMap()` を await せずに呼ぶ（内部で catch しているが、起動直後の失敗が見えにくい）。

```
src/modules/weather/
  index.ts        # install / mentionHook / schedule
  api.ts          # primary_area.xml, city map, forecast, キャッシュ
  format.ts       # WeatherInfo → MFM（純関数）
  resolve.ts      # 地名 → areaId（純関数 + キャッシュ）
```

**`info`（657行）**

- モジュールの import 時に `initializeVersion()` / `setupGCMonitoring()` が走る（`info/index.ts:138-139`）。`global.gc` をモンキーパッチする。
- イベントループ遅延を `setInterval` で自前計測。`perf_hooks.monitorEventLoopDelay()` を使えばヒストグラムで正確に取れる。
- `this.ai.modules.sort(...)` が破壊的。
- `formatSafeConfigInfo()` は設定の許可リスト。設定項目が増えるたびに手で追加が必要。
- `getDatabaseStats()` は毎回 `JSON.stringify(collection.data)` で全ドキュメントをシリアライズ（`ai.ts:83-90`）。

**提案**

```
src/modules/info/
  index.ts        # mentionHook / 返信の組み立て
  diagnostics.ts  # event loop, GC, memory, uptime
  db-stats.ts     # DB統計（キャッシュ付き）
  config-view.ts  # 安全な設定スナップショット
```

- `monitorEventLoopDelay({ resolution: 20 }).enable()` で p50/p99/max を取得。
- `global.gc` のラップはやめ、`--expose-gc` がある場合のみ `process.memoryUsage()` と GC 統計を別途取る。
- DB統計は `info` 実行時のみ計算し、結果を60秒キャッシュ。`collection.count()` と `JSON.stringify` のサイズは必要なら別スレッド/workerに逃がす。
- 設定表示は `config-view.ts` に許可リストを集約し、`Config` 型からキーを列挙して漏れを型で検出できるようにする（`satisfies Record<keyof SafeConfig, ...>`）。

**効果**: `info` の import 副作用がなくなり、テスト可能に。イベントループ計測が正確に。DB統計でイベントループを止めにくくなる。

**規模/リスク**: M / 低。

---

### R10. データ層を「リポジトリ」で囲う（Loki の即時置換はしない）

**ねらい**: `ai.getCollection('...')` の文字列散在と、Loki 依存の漏れを止める。将来の SQLite/JSON 移行を可能にする。

**現状**

- `DatabaseManager` が `meta` / `contexts` / `timers` / `friends` / `moduleData` を作るが、モジュールは `ai.getCollection('aichatHist')` のように自由にコレクションを作る（8箇所）。
- `contexts` は `key` にしかインデックスがなく、`noteId` / `module` の一意性がない。同じノートに複数モジュールが subscribe すると `findOne` がどれを返すか不定。
- `timers` は `module` にしかインデックスがなく、期限切れ検索は全件走査。
- `logWaking` が10秒ごとに `meta` を更新するため、Loki の autosave（1秒間隔）が**10秒ごとに memory.json 全体を書き出す**。`aichatHist` や `friends` が増えると書き込み量が効いてくる。
- 終了時に `db.close()` / 明示 `saveDatabase()` を呼んでいない。SIGTERM で最大1秒分の更新が失われうる。
- issue #134「memory.jsonやめる」の通り、Loki は中期的な負債。ただし**今すぐ置換するとリスクが高い**。

**提案（段階的）**

1. **リポジトリを導入**:

```ts
// src/db/repositories/friend-repository.ts
export class FriendRepository {
  constructor(private collection: loki.Collection<FriendDoc>) {}
  findById(userId: string): FriendDoc | null { ... }
  upsert(user: User): FriendDoc { ... }
  save(doc: FriendDoc): void { ... }
}
```

対象: `FriendRepository` / `ContextRepository` / `TimerRepository` / `ModuleDataRepository` / `ChatHistoryRepository`。
`Ai` の `getCollection` は移行期間中だけ残し、新規コードはリポジトリ経由にする。

2. **インデックスと制約**:
   - `friends.userId` をユニークに。
   - `moduleData.module` をユニークに。
   - `contexts` に `module` と `noteId` / `userId` の複合インデックス。
   - `timers` に `insertedAt` のインデックス（期限切れ候補を絞る）。

3. **autosave の見直し**:
   - `logWaking` を10秒 → 5分に。`lastWakingAt` は「ざっくりした稼働記録」なので秒単位不要。
   - `autosaveInterval` を 5〜10秒に延ばす、または明示 `save()` に切り替える。
   - `Ai.stop()` で `db.saveDatabase()` + `db.close()`。

4. **マイグレーション**:
   - `meta.schemaVersion` を追加し、起動時にコレクションの形を変換。
   - 既存の `memory.json` を読んで、重複 friend / moduleData をマージする一度きりの処理。

5. **将来の置換**:
   - リポジトリのインターフェースを満たす `LokiFriendRepository` と `SqliteFriendRepository` を用意できる形にする。ただし置換は R10 の最後、計測してから。

**効果**: モジュールから Loki の知識が消える。書き込み頻度が下がる。終了時に安全に保存できる。将来の DB 移行が「リポジトリの差し替え」で済む。

**規模/リスク**: M / 中。まず `logWaking` の頻度と `Ai.stop()` だけでも先にやる価値がある。

---

### R11. テストを導入する（0 → 50件）

**ねらい**: 純関数からテストを始め、リファクタリングの安全網にする。

**現状**

- テストファイル0。`pnpm test` は `node --test` だが、TSテストを置いても `.js` import の解決で動かない。
- `config.ts` の import 副作用のため、モジュールを import するテストが書きにくい。

**提案**

- ランナーは **Vitest** を推奨（TSそのまま、fake timers、coverage、モック）。依存を増やしたくなければ `tsx --test` + `node:test` でも可。
- `R2` の設定ローダ純化を先に行い、テストが `config.toml` を要求しないようにする。
- 最初のテスト対象（すべて純関数に近い）:

| 対象 | テスト内容 |
|---|---|
| `aichat/tool-call-parser.ts` | ネストしたJSON、エスケープされた文字列、複数呼び出し、壊れた入力 |
| `reversi/engine.ts` | 初期盤面、合法手、反転、パス、終局 |
| `maze/gen-maze.ts` | 同じseedで同じ迷路、寸法、連結性 |
| `utils/or.ts` / `utils/includes.ts` | 「おはよー」「セーラー」「全角/半角」などのdenoise |
| `utils/mfm.ts` | color/bold/rainbow の文字列生成 |
| `utils/japanese.ts` | カタカナ→ひらがな、半角→全角 |
| `utils/exa.ts` / `utils/jina.ts` | `clampMaxResults`、エラー整形 |
| `follow` のホスト許可/除外 | `*.example.com`、完全一致、除外優先 |
| `update-checker` のバージョン比較 | `3.10.0 > 3.9.0`、`v` 接頭辞 |
| `config/load.ts` | 必須欠落、型違い、範囲外、正常系 |
| `utils/date.ts` | `Asia/Tokyo` の日付キー、0時跨ぎ |
| `services/scheduler.ts` | fake clock で日次実行、再起動時の再スケジュール |
| `aichat/prompt-builder.ts` | 日時・master・friendName・grounding の含有 |
| `api/upload.ts` | ローカルHTTPサーバーで `aGVsbG8=`、got 15 の回帰防止 |
| `Message` | ノート/チャットのgetter、`extractedText`、null text |

- `pnpm test` は `vitest run`、`pnpm test:watch` は `vitest`。
- CI ではネットワークを使わない（`users/show` などはモック）。

**効果**: リファクタリングの前提ができる。特に `tool-call-parser` / `reversi` / `config` はバグが出やすい。

**規模/リスク**: S（基盤）+ 継続。最初の10件だけでも価値がある。

---

### R12. 依存関係とリポジトリ構成の整理

**ねらい**: 使っていない依存・重複した依存・誤配置を減らす。

**現状**

| 依存 | 状況 | 提案 |
|---|---|---|
| `days` | `src` で未使用 | 削除 |
| `misskey-reversi` | `src` で未使用 | 削除 |
| `axios` | `kiatsu` / `weather` の2ファイルのみ | `got` に統一して削除 |
| `got` | 12ファイル | 継続。`http/client.ts` に閉じ込める |
| `random-seed` / `seedrandom` | 両方使用 | どちらかに統一（`seedrandom` は `vocabulary` / `fortune`、`random-seed` は `maze`） |
| `uuid` | `TimerManager` のみ | `crypto.randomUUID()` に置換して削除 |
| `memory-streams` | `keyword/mecab.ts` のみ | `node:stream/consumers` の `text()` に置換 |
| `node-cron` | `time-signal` のみ | R4 の `Scheduler` に置換 |
| `dayjs` | `time-signal` のみ | `Clock` / `Intl` に寄せて削除候補 |
| `formdata-node` | `APIClient` のみ（`ai.ts` は未使用import） | Node 22 のグローバル `FormData` / `File` を試して削除候補 |
| `@types/*` | `dependencies` に混在 | `devDependencies` へ |
| `typescript` / `ts-patch` / `nodemon` | `dependencies` に混在 | `devDependencies` へ |

- `pnpm-workspace.yaml` の `packages: [src/**]` は、`src` 配下に `package.json` がないため実質不要。削除するか、本当にワークスペース化する。
- `package.json` に `engines.node`（例: `>=22`）と `packageManager` を追加。
- `.dockerignore` / `.gitignore` は良好。`built` / `node_modules` / `memory.json` が除外されている。

**効果**: インストールサイズと攻撃面が減る。Node 組み込みで置き換えられるものが明確になる。

**規模/リスク**: S / 低。1依存ずつPRを分けると安全。

---

### R13. その他の整理（低優先）

| 対象 | 提案 |
|---|---|
| `src/index.ts` の34個の import + `new` | `src/modules/registry.ts` に `moduleFactories` を集約。追加時の変更を1ファイルに |
| モジュールの有効/無効判定 | `install()` 内の `if (!config.x) return {}` を `isEnabled(config)` に統一。`=== false` と `!value` の混在を解消 |
| `serifs.ts` | `serifs.toml` の型・スキーマを用意し、未知キーを警告。`deepMerge` の関数パラメータ名依存をテストで固定 |
| `index.html`（39KB） | JSON/YAML→TOML の一度きりの移行ツール。`docs/migration/` に移すか、移行完了後に削除。設定スキーマの二重管理になる |
| `issue_analysis.md` / `MIGRATION-GUIDE.md` | `docs/` に移動。ルートの docs が乱雑 |
| `README.md` | `npm` 前提の記述を `pnpm` に更新。Node バージョン、lockfile、CI バッジを追加 |
| `reversi/index.ts`（`back.ts` を fork） | 子プロセスが常駐する。`Ai.stop()` で子プロセスを kill する |
| `stream.ts` | `buffer` の上限を設ける（未接続時に無限に溜まる）。`JSON.parse` を try/catch。`close()` で `close` リスナも外す |
| `APIClient.post` | `param` を破壊的に変更している（`param.visibility = ...`）。コピーしてから変更 |

---

## 4. 実装順序（PR分割）

| Phase | PR | 内容 | 主なファイル | 依存 | 規模 | リスク |
|---|---|---|---|---|---|---|
| 0 | #1 | ビルド修正 + lockfile + CI骨組み | `package.json`, `Dockerfile`, `.github/workflows/ci.yml` | なし | S | 低 |
| 0 | #2 | P0 実行時バグ（upload / base64 / hook隔離 / update-checker） | `APIClient.ts`, `url2base64.ts`, `ai.ts`, `TimerManager.ts`, `update-checker` | #1 | S | 低 |
| 1 | #3 | 品質ベースライン（biome subset / 未使用削除 / Vitest 導入 / 最初の10テスト） | `biome.json`, `package.json`, `*.test.ts` | #1 | S | 低 |
| 1 | #4 | 設定ローダ + スキーマ + 日付/Clock + テスト | `src/config/**`, `utils/date.ts` | #3 | M | 中 |
| 2 | #5 | `Module<T>` + `dispose()` + `every()` + SIGTERM。小さい5モジュールで試験導入 | `module.ts`, `ai.ts`, `birthday`, `valentine`, `timer`, `ping`, `dice` | #4 | M | 中 |
| 2 | #6 | 共通サービス（relationship / reaction / logger / errors / http）と全モジュール移行 | `src/services/**`, `src/http/**`, 各モジュール | #5 | M | 中 |
| 3 | #7 | `Message` 判別共用体 + `FriendRepository` + ユニーク制約 | `message.ts`, `friend.ts`, `DatabaseManager.ts` | #6 | M | 中 |
| 3 | #8 | aichat 分割（media / prompt-builder / providers の順） | `modules/aichat/**` | #6, #3 | L | 中〜高 |
| 3 | #9 | earthquake 分割（format → ws client → index） | `modules/earthquake_warning/**` | #6, #3 | L | 中 |
| 4 | #10 | weather / info / imagen / veo 分割 | 各モジュール | #6 | M | 低〜中 |
| 4 | #11 | DB リポジトリ + autosave 調整 + graceful shutdown | `src/db/**`, `DatabaseManager.ts`, `ai.ts` | #5, #7 | M | 中 |
| 5 | #12 | `noImplicitAny` 段階有効化、依存整理、docs | 全体 | #3-#11 | L | 低 |

**ポイント**

- #1 と #2 は**今すぐ**。他のすべての前提。
- #5 の `dispose()` と `every()` は、#8/#9 の分割前に必ず入れる。そうしないと分割したモジュールがタイマーを止められない。
- #8 と #9 は独立なので並行できる。ただし #3 のテスト（tool-call-parser / 地震フォーマッタ）を先に。
- 大規模なフォーマット変更（Biome の一括適用）は**ロジック変更と同じPRに混ぜない**。

---

## 5. 目標とするディレクトリ構成

```
src/
  index.ts                 # composition root（設定読込 → Ai 起動だけ）
  app/
    ai.ts                  # 起動・停止のファサード
    message-router.ts      # context / mention hook のディスパッチ
    stream-coordinator.ts  # WebSocket の配線
  config/
    schema.ts              # 型 + 既定値 + 検証
    load.ts                # 純粋なローダ
    index.ts               # initConfig / config
  api/
    APIClient.ts           # Misskey API
  db/
    DatabaseManager.ts
    repositories/*.ts
  services/
    relationship.ts
    reaction.ts
    scheduler.ts
    clock.ts
    logger.ts
    errors.ts
  http/
    client.ts
    search.ts
  render/
    canvas.ts
    font.ts
    upload.ts
  modules/
    ...                    # 各モジュール。index.ts はフックのみ
  utils/
    japanese.ts
    mfm.ts
    ...
```

すべてを一度に作る必要はありません。**新規コードはこの形に置き、既存コードは触ったときに移す**のが現実的です。

---

## 6. やらない方がいいこと

1. **Loki を今すぐ SQLite に置き換える**  
   `memory.json` の移行・互換・障害時の復旧を同時に設計する必要がある。まずリポジトリで囲い、書き込み頻度とサイズを計測してから。

2. **全モジュールを一斉に DI 化する**  
   `config` の import を全ファイルで書き換えると差分が巨大になり、レビューできない。まず `initConfig` で副作用を除去し、新規コードからコンストラクタ注入にする。

3. **モジュールを実行時に自動検出する**  
   `fs.readdir` + 動的 import はビルド成果物とテストで扱いにくい。静的な `registry.ts` の方が安全。

4. **`serifs` / `reversi` のアルゴリズムを書き換える**  
   すでに分離されており、テストもなく触る理由が薄い。まず型とテストを付ける。

5. **Biome の推奨ルールを一度に全部有効化する**  
   数百件の差分が出て、他の変更と混ざる。ルールグループごとにPRを分ける。

6. **`any` を一括で `unknown` に置き換える**  
   コンパイルは通っても実行時の分岐が増える。`any` の多いファイル（aichat / chart / reversi/back）を分割してから、ファイル単位で直す。

---

## 7. 完了条件（メトリクス）

| 指標 | 現在 | 目標 |
|---|---:|---:|
| `pnpm build` | 失敗 | 成功（クリーンclone + `--frozen-lockfile`） |
| `tsc --noEmit` | 3エラー | 0 |
| `biome ci` | 51 | 0 |
| 未使用 import / 変数 | 17 | 0 |
| `noImplicitAny` エラー | 134 | 0（段階的） |
| `any` 系の記述 | 約122 | 50以下 |
| テスト数 | 0 | 50以上 |
| 最大ファイル行数 | 2,067 | 500以下 |
| `setInterval` を直接呼ぶモジュール | 16 | 0（`Module.every()` 経由） |
| 終了時に開いたままのリソース | 未検証 | `dispose()` 後0（テストで確認） |
| 設定エラー | 黙って無視 | キー名付きで起動時に失敗 |

---

## 8. 付録

### A. 再現コマンド

```bash
# 依存（この環境では npm で確認。本来は pnpm）
npm install --ignore-scripts

# 型チェック
npx tsc --noEmit

# ビルド（失敗する）
npx tspc --noEmit

# lint（0件 = 実質無効）
npx biome lint src

# lint + format + import整理（51件）
npx biome check src

# 未使用
npx tsc --noEmit --noUnusedLocals --noUnusedParameters

# noImplicitAny を有効にした場合
npx tsc --noEmit --noImplicitAny
```

got 15 の2つの挙動:

```bash
node --input-type=module -e "
import got from 'got';
try { got.post({ url: 'http://127.0.0.1:1/x', body: 'a' }); }
catch (e) { console.log(e.message); }
"
# The `url` option is not supported in options objects. Pass it as the first argument instead.

node --input-type=module -e "
import http from 'node:http';
import got from 'got';
const s = http.createServer((_, res) => res.end(Buffer.from('hello')));
await new Promise(r => s.listen(0, '127.0.0.1', r));
const b = await got('http://127.0.0.1:' + s.address().port).buffer();
console.log(b.constructor.name, b.toString('base64'));
s.close();
"
# Uint8Array 104,101,108,108,111
```

### B. 主要な重複箇所（grep用）

```text
isFollowing        src/modules/aichat/index.ts:1422
                   src/modules/imagen/index.ts:103
                   src/modules/veo/index.ts:63

isMaster            src/modules/follow/index.ts:42
                   src/modules/aichat/index.ts:1441
                   src/modules/info/index.ts:567

notes/reactions/create
                   src/ai.ts:180, src/ai.ts:341,
                   src/modules/emoji-react/index.ts:39,
                   src/modules/imagen/index.ts:526,
                   src/modules/ping/index.ts:43,
                   src/modules/veo/index.ts:224,
                   src/modules/welcome/index.ts:26

note files → base64
                   src/modules/aichat/index.ts:1312, 1362
                   src/modules/imagen/index.ts:300, 375

Gemini API         src/modules/aichat/index.ts:343, 825
                   src/modules/imagen/index.ts:120, 244
                   src/modules/veo/index.ts:80

daily schedule     src/modules/chart/index.ts:17,27
                   src/modules/maze/index.ts:18,28
                   src/modules/check-custom-emojis/index.ts:24,34
                   src/modules/birthday/index.ts:16
                   src/modules/valentine/index.ts:12
                   src/modules/weather/index.ts:358
```

### C. 参考: 各モジュールの行数（上位）

| ファイル | 行数 |
|---|---:|
| `src/modules/aichat/index.ts` | 2,067 |
| `src/modules/earthquake_warning/index.ts` | 1,193 |
| `src/modules/imagen/index.ts` | 669 |
| `src/serifs.ts` | 663 |
| `src/modules/info/index.ts` | 657 |
| `src/modules/reversi/back.ts` | 522 |
| `src/ai.ts` | 511 |
| `src/modules/weather/index.ts` | 495 |
| `src/modules/follow/index.ts` | 495 |
| `src/vocabulary.ts` | 480 |

---

## 9. まとめ

このリポジトリは「機能追加の速さ」に対して「構造の維持コスト」が追いつき始めている状態です。ただし、`Module` / `APIClient` / `DatabaseManager` / `TimerManager` という分割の方向性は正しく、全面的な書き直しは不要です。

**最初の1週間でやるべきことは、リファクタリングではなく「ビルドと実行を正常に戻すこと」**。その後、R1〜R4 で土台を整え、R6/R7 で大型モジュールを分割するのが最短ルートです。

特に効果が大きいのは:

- **P0-2 / P0-3**: 画像系機能が実際に壊れている
- **P0-4**: 1モジュールの例外が全体を止める
- **R2**: 設定ミスが起動時に分かり、テストが書ける
- **R3**: モジュールが停止でき、タイマーが漏れない
- **R4**: 同じ修正を7回書かなくて済む

この順で進めれば、機能を止めずに少しずつ安全度を上げられます。
