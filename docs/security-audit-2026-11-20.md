# セキュリティ監査・バグ修正報告書 (2026-11-20)

対象: 本リポジトリ (Misskey AI チャットボット、TypeScript / Node 22)
方式: サブエージェント・オーケストレーションによる調査 (5系統) → トリアージ → 修正 (4系統+フォローアップ) → 2系統レビュー → 最終検証

## 最終検証結果

- `pnpm typecheck` 合格
- `pnpm test` 合格 (25ファイル / 118テスト。修正前は106テスト)
- `pnpm lint:ci` 合格
- 差分: 34ファイル / +702行 / -113行 (コミットは未実施)

## 修正済みの重要な脆弱性・バグ

### セキュリティ (High)

1. **チャート描画の無限ループ (DoS)** — `src/modules/chart/render-chart.ts`。データが定数でゼロでないとき (例: フォロワー数が一定期間変化しない場合)、`niceScale` の `while(1)` が `NaN` を際限なく push し、メモリを使い切ってプロセスが固まっていた。stepSize の有限性ガードと、全0データ・空データの早期リターンを追加した。
2. **プロトタイプ汚染** — `src/serifs.ts` の `deepMerge` は `__proto__` キーで `Object.prototype` を汚染し得た。`Object.keys` への切り替えと危険キー (`__proto__` / `constructor` / `prototype`) のスキップを追加し、テストで実際の汚染が起きないことを確認した。
3. **SSRF 対策 (aichat URL コンテキスト)** — `src/modules/aichat/url-context.ts`。ユーザー指定 URL の取得にプライベートアドレス判定がなく、`http://127.0.0.1` やメタデータエンドポイントを Bot に取得させ得た。`isPrivateUrl` ヘルパー (ループバック / プライベート IP / リンクローカル / IPv4-mapped IPv6 に対応) を追加した。YouTube 判定も hostname の厳密一致に変更した。
4. **絵文字チェックの権限チェック欠如** — `src/modules/check-custom-emojis/index.ts`。誰でも「カスタム絵文字チェック」のメンションで全サーバーへの投稿を強制でき、連投すればスパムになり得た。master 判定を追加した。
5. **veo ポーリングのタイムアウト欠如** — `src/modules/veo/client.ts`。ポーリング GET にタイムアウトがなく、API が固まると `mentionHook` ごと無期限に待機し得た。タイムアウトを設定した。

### セキュリティ (Medium)

6. **WebSocket トークンの未エスケープ** — `src/stream.ts`。`encodeURIComponent` を適用した。
7. **transferCode の低エントロピー** — `src/friend.ts`。`Math.random` ベースから `crypto.randomBytes(16)` に変更し、転移成功時にコードを無効化するようにした。
8. **poll のマスターバイパス** — `src/modules/poll/index.ts`。旧条件ではリモートの非 master が `/poll` を実行できた。ローカル master のみに制限した。

### バグ (主なもの)

9. **地震情報の二重投稿レース** — `src/modules/earthquake_warning/index.ts`。楽観ロック (プレースホルダの先行登録) を導入し、投稿失敗時はプレースホルダを削除するようにした。
10. **天気 API 失敗時の誤応答** — `src/modules/weather/`。キャッシュ取得の失敗が「地域不明」という誤った応答になっていたのを修正し、同じキャッシュ更新の重複取得も1つにまとめるようにした。
11. **core / reminder の購読キー不整合** — チャット時の再購読キーを購読時と同一に統一した。
12. **keyword / mecab / ping の未処理例外** — try-catch による保護と、子プロセスの error イベントのハンドリングを追加した。
13. **履歴管理** — aichat の履歴上限のシフトを while に修正し、base64 画像の参照 (quotedFiles) を handle 完了後にクリアするようにした。
14. **uncaughtException 後のプロセス継続** — `src/index.ts`。graceful shutdown (`ai.stop()` と10秒後の強制終了) を追加した。
15. **その他** — guessing-game の機能していない入力チェックの修正、reversi の API タイムアウトと盤面の範囲外 pos 検証、url2base64 の 20MB 上限、update-checker のタイムアウトと User-Agent、serifs の TOML パースエラーのログ出力、config 正規化の非破壊化、stream の close 時における nonSharedConnections の破棄、gemini.ts のデッドコード移動。
16. **OpenAI 最終リクエストへの tools 同梱** — `src/modules/aichat/providers/openai.ts`。tool ロールメッセージがあるのにツール定義がないと400エラーになるプロバイダがあるため、最終リクエストにも tools を渡すようにした。
17. **Gemini API キーをヘッダーへ移行** — `src/modules/aichat/providers/gemini.ts`。クエリパラメータから `x-goog-api-key` ヘッダーに変更し、got 呼び出しに 60秒タイムアウトを追加。あわせて openai/gemini 両プロバイダのレスポンス全文ログを1000文字に切り詰めた。
18. **veo ダウンロード URI の検証** — `src/modules/veo/client.ts`。API レスポンスの `video.uri` が `https://` かつ googleapis.com/google.com 系ホストであることを確認してから取得するようにした。
19. **ネットワーク系の細部** — APIClient.api に `retry: { limit: 0 }` を明示、http/client の GET 系はデフォルト retry 2、weather のログ切り詰め。
20. **chatUser 接続の重複増加** — `src/ai.ts`。ユーザーごとの接続を Map で一元管理し、既存接続を再利用するようにした (アイドル切断時の管理も整合)。
21. **learnedKeywords の定期削除** — `src/modules/keyword/index.ts`。learnedAt が30日超のエントリを1日1回削除するようにした。
22. **url2json の戻り値型** — `Promise<string>` から `Promise<unknown>` に修正。

## 残存する既知の制限 (設計判断・未対応)

- **isPrivateUrl は簡易チェック**: DNS ベースのバイパス (`localtest.me` のように、ドメイン名でプライベート IP を引く手法) は防げない。完全に対応するには DNS 解決後の IP 検証が必要 (コメントに明記済み)。
- **url2base64 のガードは軽量**: LAN 内 Misskey 運用を壊さないため、RFC1918 (192.168/10/172.16-31) は対象外。ループバック・リンクローカルのみ拒否。
- **unhandledRejection は exitCode の設定のみ**: シャットダウンを開始しない (uncaughtException と非対称)。動作を優先する設計判断。
- **kazutori の勝者ルール** (最大ユニーク数) が一般ルール (最小) と異なる可能性 — 利用者の指示により今回の修正対象から除外。
- **follow モジュールの3時間でのフォロー解除** — 新規フォローが実質無意味になる可能性。仕様の確認待ち。
- **message.ts の text 型偽装** (`string` 型だが実態は null の場合あり) — 大規模な移行が必要なため見送り。

## テスト追加

- `tests/chart-axis.test.ts`: 定数非ゼロ・全0・空データの3ケース (無限ループ防止、タイムアウト付き)
- `tests/serifs.test.ts`: プロトタイプ汚染の防止を確認
- `tests/url-context.test.ts`: isPrivateUrl の拒否と許可 (12テスト、IPv4-mapped IPv6 を含む)

## 検証プロセス

1. 修正前のベースライン: typecheck / test (106) / lint がすべてグリーンであることを確認
2. 5系統の調査エージェントがコードベース全体 (17,648行 / 115ファイル) を精読
3. メインエージェントがトリアージし、修正対象と見送り (仕様確認が必要なもの) を判断
4. 4系統の修正エージェントが並行して修正 → 2系統のレビューエージェント (正確性レビュー / 攻撃的レビュー) が検証
5. レビューで発見された残課題 (IPv4-mapped IPv6 バイパス、earthquake プレースホルダの残存) をフォローアップ修正
6. 最終検証: typecheck 合格 / test 116/116 合格 / lint 合格
