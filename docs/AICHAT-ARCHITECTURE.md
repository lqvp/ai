# aichat アーキテクチャ設計（mugi-misskey 方式への刷新）

PR #511 で導入された追記型エピソード記憶・気分エンジン・TL日記・プロアクティブDMを全面撤去し、`lqvp/mugi-misskey` の設計思想と堅牢なガードレールに基づく新方式へ刷新した。

## 設計の柱

1. **2段階ハイブリッド応答（会話と評価の完全分離）**
   - **Step 1（前景応答・自然文）**: `ChatHandler` がマルチモーダル・Web検索・URLコンテキスト・（マスター専用の）Misskeyツールを維持したまま自然なMarkdown本文を生成・送信する。Gemini のグラウンディング情報等は `metadataSuffix` に分離し、会話履歴にはクリーンな本文のみを残す。
   - **Step 2（背景監査・極小JSONサイドカー）**: `interaction-auditor.ts` がユーザーの最新発言のみ（ボットの返信は渡さない）を入力とし、10秒タイムアウト付きの極小JSON `{ reaction, delta, note }` でリアクションと好感度更新を決める。ボット自身の発言による自己強化学習ループを構造的に防止する。
   - **思考モデル/vLLM耐性**: `structured-llm.ts` が `<think>`・孤立 `</think>`・未閉鎖 `<think>` を除去し、フェンス剥がし・括弧対応スキャン・1回の修復リトライを行う。OpenAI 互換ではデフォルトで `response_format` を送らず、Gemini ではツール無し JSON 呼び出しで `responseMimeType: 'application/json'` を使用する。

2. **暴走しない好感度・1行メモ (`memoryDir/aichat-affinity.json`)**
   - ユーザーごとに `{ userId, score (-100..100), notes (120コードポイント以内の1行メモ), last }` を保持。
   - `notes` は **上書きのみ**（追記禁止）とし、8文字未満の短文・汎用フィラー・NFKC同値書き換え・インジェクション表現・TL巡回時（`wander`）の更新を禁止する。
   - `turnSeq` により非同期 Step 2 が後から完了しても古いメモで上書きしない。非アクティブ時の自然減衰・短時間連続プラス加算のクールダウン・マスター固定(100)をコード側で保証する。

3. **ランダム時刻 TL 巡回 (`wander-scheduler.ts` / `wander.ts` / `memoryDir/aichat-wander.json`)**
   - `mugi-misskey` ADR 0002 に準拠し、9〜23時（JST）に5分ティックで毎時 0〜3 回のランダムスロットを抽選。
   - 投稿前フィルタ（bot/CW/返信/引用/限定公開/センシティブ/@含む/既対応/リアクション済み/経過時間）＋シャッフル＋確率予算＋ユーザー別クールダウン＋行動サマリー直近10件により機械的挙動や重複連投を防止する。
   - 巡回リプライ・独り言には `#aichat` を付けず、`postNotPublic` を尊重し、ユーザーからの返信は `contextHook` で引き継ぐ。

4. **インスタンスカスタム絵文字カタログ (`emoji-catalog.ts` / `memoryDir/aichat-emojis-cache.json`)**
   - `POST /api/emojis` を6時間キャッシュし、`isSensitive`・NSFWカテゴリ・ロール制限絵文字を除外。`localOnly` 絵文字はリモートノートへのリアクションで使わない。
   - 3層ショートリスト（文脈マッチ＋汎用定番＋ローカルランダム、直近5件除外）から選び、送信前に `twemoji-parser` と実在カタログで検証する。

5. **明確な権限境界と永続化信頼性 (`playbook.ts` / `json-file-store.ts`)**
   - `PLAYBOOK.md`（初回自動シード・ホットリロード・最大64KB）と `RelationshipService`（`masterUserId` 優先、ローカル限定）でマスター権限を厳格化。
   - `misskeyTools` はマスター専用、Webツールもデフォルトでマスター専用（`allowNonMasterWebTools` でオプトイン可）。OpenAI の `parseToolCallsFromContent` も `allowedTools` ホワイトリストで防御する。
   - `JsonFileStore` によりファイル単位キュー直列化・`tmp + rename` アトミック書き込み・破損JSONの `.bak` 退避・プロトタイプ汚染対策を実施する。

6. **セッションライフサイクル修正 (`history-repository.ts` / `chat-handler.ts` / `ai.ts`)**
   - 旧 `setTimeoutWithPersistence` による会話途中強制終了や `context` の先行削除バグを廃止し、`sessionId` + `expiresAt` + 60秒スイーパ + セッションロック + 最大3件スライディングウィンドウ + 返信分岐フォークへ刷新。
   - 拒否/無視/失敗時は `{ reaction: null, immediate: true }` を返し、`ai.ts` のデフォルト `'love'` リアクションや `TalkModule` へのフォールバックを確実に抑止する。
