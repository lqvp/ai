# 開かれているIssueの実装可能性分析

## 概要

Misskey用AI Bot「藍」のリポジトリ `lqvp/ai` で現在開かれているissueの中から、すぐに実装に移せそうなものを調査・分析しました。

## 調査対象Issue一覧

| Issue番号 | タイトル | 作成日 | 実装難易度 |
|----------|----------|---------|------------|
| #174 | infoで一部config表示 | 2025-07-08 | ✅ **実装完了** |
| #172 | veo support | 2025-07-07 | 🔶 中程度 |
| #171 | 地震周りが動いてない？ | 2025-07-07 | 🔍 調査必要 |
| #170 | follow me周りの改善 | 2025-07-07 | 🔶 中程度 |
| #169 | aichatで引用先のファイルを見るように | 2025-07-06 | 🔶 中程度 |
| #157 | mentionHooksの取扱周り | 2025-07-01 | 🔴 高難易度 |
| #134 | memory.jsonやめる | 2025-06-14 | 🔴 高難易度 |
| #62 | aichat用メモリー | 2025-02-21 | 🔶 中程度 |
| #16 | Dependency Dashboard | 2025-01-07 | 🔵 メンテナンス |

## 実装完了Issue

### Issue #174: infoで一部config表示 ✅

**実装内容:**
- マスターユーザーのinfo画面に安全な設定情報を表示する機能を追加
- APIキーやトークンなどの機密情報は除外し、以下の情報のみ表示：
  - 基本機能の有効/無効（キーワード検索、リバーシ、自動単語等）
  - ゲーム機能設定（迷路、投票）
  - 投稿設定（公開範囲等）
  - AI機能設定（Geminiの各種設定）
  - 地震速報・気圧監視設定
  - その他の機能設定

**実装箇所:**
- `src/modules/info/index.ts` に設定情報表示機能を追加

**コード品質改善:**
PRレビューを受けて以下のリファクタリングを実施：
- 長い関数（100行+）を機能別の小さな関数に分割：
  - `formatBasicFeatures()` - 基本機能設定
  - `formatGameFeatures()` - ゲーム機能設定
  - `formatPostSettings()` - 投稿設定
  - `formatAIFeatures()` - AI機能設定
  - `formatEarthquakeSettings()` - 地震速報設定
  - `formatPressureSettings()` - 気圧監視設定
  - `formatOtherSettings()` - その他の設定
- ハードコーディングされた文字列を`CONFIG_LABELS`定数オブジェクトに集約
- `safeConfigValue()`と`formatBooleanSetting()`ヘルパー関数で一貫したnull/undefined処理
- ビルド・lint・format全て成功確認済み

## すぐに実装可能なIssue

### Issue #170: follow me周りの改善 🔶

**要求内容:**
- masterがユーザーをメンションしてフォローさせる機能
- 設定変更なしで一時的に許可する機能

**実装方針:**
- 既存のfollowモジュール（`src/modules/follow/`）を拡張
- masterユーザーからの特別なコマンド処理を追加
- 一時的な許可機能のためのメモリ管理

### Issue #169: aichatで引用先のファイルを見るように 🔶

**要求内容:**
- aichat機能で引用投稿のファイルも参照できるようにする

**現在の実装状況:**
- YouTubeURL、一般WebページのURL処理は実装済み
- 画像ファイルのbase64変換も実装済み（`note2base64File`関数）

**実装方針:**
- 引用投稿（quote）の検出機能を追加
- 引用先投稿の添付ファイルを取得・処理する機能を拡張

## 中長期実装Issue

### Issue #172: veo support 🔶

- Googleの新しい動画生成AI「Veo」のサポート
- API仕様の調査が必要

### Issue #171: 地震周りが動いてない？ 🔍

- 地震速報機能の動作確認・デバッグが必要
- 既存の `earthquake_warning` モジュールの調査

### Issue #62: aichat用メモリー 🔶

- aichat機能の会話履歴管理改善
- 現在のLokiJSベースのメモリ管理との統合

## 技術的課題があるIssue

### Issue #157: mentionHooksの取扱周り 🔴

- モジュールシステムの核心部分の変更が必要
- 全体的な影響範囲が大きい

### Issue #134: memory.jsonやめる 🔴

- データ永続化システムの根本的な変更
- 大規模なリファクタリングが必要

## 推奨実装順序

1. ✅ **Issue #174** - 実装完了
2. 🥇 **Issue #170** - follow機能改善（比較的独立性が高い）
3. 🥈 **Issue #169** - aichat機能拡張（既存実装の拡張）
4. 🥉 **Issue #171** - 地震機能調査・修正（デバッグ作業）
5. **Issue #172** - Veo support（API調査後）
6. **Issue #62** - aichat用メモリー（設計検討後）

## 結論

現在開かれているissueの中で、**Issue #174は実装完了**し、**Issue #170**と**Issue #169**が次に実装しやすい候補として挙げられます。特にIssue #170（follow機能改善）は既存のfollowモジュールの拡張として比較的独立して実装でき、すぐに取り組めると考えられます。