# ユーザーメモリー / パーソナライズ機能 実装概要

> 2025-07-19 追加 (by o3-AI assistant)

## 目的

* ユーザーとの対話内容を永続的に蓄積し、次回以降の会話で活用することで "あなたを知っている" 体験を提供する
* 発言内容を意味的に検索し、関連する思い出を **Gemini** プロンプトに自動注入
* 低コスト運用を維持したまま、後から高精度なベクトル検索に差し替え可能な構成にする

---

## 主要コンポーネント

| ファイル | 役割 |
|-----------|------|
| `src/memory/SmartMemoryManager.ts` | ユーザーメモリー CRUD / 検索・保守ロジック |
| `src/utils/similarity.ts` | Jaccard 風トークン一致率による類似度計算 |
| `src/utils/cosine.ts` | ベクトル間コサイン類似度計算 |
| `src/modules/aichat/index.ts` | • SmartMemoryManager を注入<br>• 対話後に `storeUserMessage` で学習<br>• 生成前に `getRelevantMemories` で記憶を取得し System Instruction に挿入 |

### SmartMemoryManager の流れ

1. **保存** `storeUserMessage(userId, text)`  
   * テキストをトリム後、非同期で Gemini *embedding-001* API を呼び出し、512 次元ベクトルを取得 (失敗時はスキップ)。  
   * `memories` コレクションに LokiJS ドキュメントとして永続化
2. **検索** `getRelevantMemories(userId, query, limit)`  
   * クエリ文の埋め込みを取得 (可能なら)。  
   * 各メモリについて  
     * テキスト類似度 (token overlap)  
     * ベクトル類似度 (cosine)  
     * 重要度スコア  
     を合成し順位付け
3. **保守** `maintainMemory()`  
   * ユーザーごとに新しい順で上限 `maxPerUser` を超えたレコードを削除 (呼び出しは cron 可)

---

## Gemini との連携

* **Embedding 生成**  
  `POST https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=<API_KEY>`
* **System Instruction 拡張**  
  検索結果を `【このユーザーに関する記憶】` セクションとして付与。

```text
【このユーザーに関する記憶】
・好きなアニメは『○○』
・猫を2匹飼っている
...
```

LLM はこれを参照し、よりパーソナルな応答を生成します。

---

## 環境変数 / 設定

* `config.gemini.enabled = true`
* `config.gemini.apiKey  = "YOUR_API_KEY"`

> **Tip**: API キーが設定されていない場合でも、テキスト類似検索のみで動作します。

---

## 今後の発展ポイント

* **重要度推定**: LLM Analyzer で `should_write_memory` 判定 or importance スコアを自動付与
* **要約ローテーション**: 古い記憶を LLM に要約させストレージを圧縮
* **性格推定**: Big-Five 推論 → `FriendDoc` に格納、`AdaptivePersonalization` で利用
* **ベクトル DB 移行**: Chroma / Weaviate などに切替時も SmartMemoryManager を差し替えるだけで済む設計

---

## コミット内容

* `src/memory/SmartMemoryManager.ts` 新規追加
* `src/utils/similarity.ts` / `src/utils/cosine.ts` 新規追加
* `src/modules/aichat/index.ts` に Memory 組込み
* `MEMORY_PERSONALIZATION.md` (本ドキュメント)

---

Happy hacking! 🎉
