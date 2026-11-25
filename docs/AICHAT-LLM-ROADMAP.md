# aichat LLM活用拡張ロードマップ実装記録（アーカイブ / 刷新済み）

> **更新 (2026-11-24)**: 本ドキュメントに記載されていた PR #511（エピソード記憶・気分エンジン・TL日記・プロアクティブDM）は、記憶の暴走および多数の実装バグを解消するため撤去され、`lqvp/mugi-misskey` 方式を取り入れた新アーキテクチャへ刷新されました。現行設計については [docs/AICHAT-ARCHITECTURE.md](./AICHAT-ARCHITECTURE.md) を参照してください。

作成日: 2026-11-20

## 背景

Misskey Bot「藍」のaichatモジュールについて、LLM活用を充実させるための拡張を
パネルディスカッション（glm系2パネリスト・手法分岐方式）で検討し、
承認を得て実装した。本ドキュメントは計画と実装結果の記録である。

この拡張の前提となった先行リファクタリングは次のとおりである。

- OpenAI互換APIの設定一元化（`openai-settings.ts`）
- Misskey操作ツール（`misskey-tools.ts`）とLLM randomTalk選択（`note-selector.ts`）
- リアクション衝突の抑制（`coreReactionFor`）

## 実装した機能

### Phase 1: エピソード記憶システム

会話終了時にLLMが「長期記憶に値する事実のみ」をJSONで抽出し、
lokijsコレクション `aichatMemory` に保存する。次回会話時に重要度の高い
記憶が回想としてシステムプロンプトへ注入される。

- 抽出: `episode-extractor.ts`（抽出プロンプトは実データでのMVP検証済み。
  JSON抽出成功率 6/6 = 100%）
- 保存: `episode-memory-repository.ts`（矛盾は新記憶が旧記憶を supersede,
  90日未参照かつ重要度2以下はアーカイブ）
- 注入: `prompt-builder.ts` の `buildMemoryRecallContext`（重要度4以上のみ、
  上限2000文字）

### Phase 2: 気分エンジンとリアクション人格化

- 気分状態（mood / energy / triggers）を保持し、会話終了時と6時間ごとの
  定期ジョブでLLMが更新する。急激な変動を防ぐガードレール付き
  （moodは1段階まで、energyは±20まで）
- リアクション選択を本生成リクエストに埋め込んだマーカー
  `[[REACTION: ...]]` で行い、投稿前に剥がして反映。追加LLMコールなし
- LLMツールが既にリアクション済みならコアの自動リアクション（👍）は抑制

### Phase 3: TL日記

6時間ごとにホームタイムライン（自ノート・bot・フォロワー限定を除く）を
取得し、藍の視点の主観日記（3〜5行）を生成して `aichatDiary` に保存。
保持72時間・最大20件。autoNote（独り言）の材料として注入される。

### Phase 4: プロアクティブ発話

12時間ごとに、重要度3以上のエピソード記憶から「自然なフォローアップが
歓迎されるもの」をLLMに判断させ、該当ユーザーのチャットへ1〜2文の
気遣いを送る。ガードレール: 1実行1件まで、同一ユーザー72時間スロットル、
2回無視で7日クールダウン、masterは頻度制限免除。

## 設定

example.config.toml には、すべてデフォルトで有効になる次のセクションを追加した。

```toml
[aichat.episodeMemory]   # enabled, maxMemoriesPerUser
[aichat.moodEngine]      # enabled, reactionPersonalization, updateIntervalHours
[aichat.tlDiary]         # enabled, intervalHours, retentionHours, maxEntries
[aichat.misskeyTools]    # enabled, allowReaction
[aichat.proactiveFollowup] # enabled, intervalHours, maxPerDay, cooldownDays, userThrottleHours
```

## 検証結果

- typecheck / biome lint / vitest すべて通過（36ファイル・241テスト）
- MVP検証（Phase 0）: 実会話データ6件で抽出テスト、JSON成功率100%
- 実エンドポイント（vLLM moonmath-glm53-uncensored）での動作確認済み
- 各フェーズ実装後にbotを再起動し稼働継続を確認

## 既知のリスクと未検証事項

- 「ユーザーは記憶されることを求める」という価値仮説自体が未検証。
  運用開始後に誤引用や不自然な想起の頻度を観察し、抽出段階の
  チューニングを行う必要がある
- 気分エンジンの暴走（不機嫌の長期化）はガードレールで抑制しているが、
  長期運用での飽和・振動は観察が必要
- プロアクティブ発話のスパム化リスクは頻度制御で対処済みだが、
  受け取る側の体感は運用フィードバック待ち
