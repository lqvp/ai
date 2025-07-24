# AIChat メモリー＆パーソナライゼーション機能

## 概要

このモジュールは、AIChat に高度なメモリー機能とパーソナライゼーション機能を追加します。ユーザーとの会話を記憶し、個々のユーザーの好みや性格に合わせて応答をカスタマイズします。

## 主要コンポーネント

### 1. LLMAnalyzer（統合分析エンジン）

Gemini APIを使用して会話を多角的に分析します。

#### 分析項目

- **感情分析**: ポジティブ/ネガティブ/ニュートラルと詳細な感情（喜び、悲しみ、怒り、恐れ、驚き、愛）
- **トピック抽出**: メイントピック、サブトピック、キーワード、エンティティ認識
- **意図分類**: 質問、陳述、リクエスト、挨拶、別れなど
- **記憶判定**: 保存すべきか、重要度、カテゴリ、要約
- **パーソナライゼーション提案**: 好みのスタイルと推奨される調整
- **応答ガイダンス**: トーン、長さ、絵文字使用、重点ポイント

### 2. SmartMemoryManager（スマートメモリシステム）

LLMを活用した高度な記憶管理システムです。

#### 主な機能

- **自動記憶保存**: LLMが重要と判断した情報のみを保存
- **関連記憶検索**: LLMが文脈に基づいて最も関連性の高い記憶を取得
- **記憶の要約**: 古い記憶を自動的に要約して効率的に管理
- **動的カテゴリ分類**: LLMが内容に応じて適切なカテゴリを判断
- **プロファイル生成**: 記憶から総合的なユーザープロファイルを生成

### 3. AdaptivePersonalization（適応的パーソナライゼーション）

ユーザーの性格と好みを学習し、最適な応答スタイルを提供します。

#### ビッグファイブ性格特性

- **開放性（Openness）**: 新しい経験への開放性
- **誠実性（Conscientiousness）**: 計画性と詳細への注意
- **外向性（Extraversion）**: 社交性とエネルギー
- **協調性（Agreeableness）**: 協力性と思いやり
- **神経症傾向（Neuroticism）**: 感情的な安定性

#### コミュニケーション好み

- **応答の長さ**: 簡潔/標準/詳細/適応的
- **フォーマル度**: 0.0-1.0のスケール
- **感情表現**: 0.0-1.0のスケール
- **ユーモアレベル**: 0.0-1.0のスケール
- **技術的深さ**: 0.0-1.0のスケール
- **創造性レベル**: 0.0-1.0のスケール

### 4. ConversationManager（会話フロー管理）

会話の流れと文脈を管理し、一貫性のある応答を実現します。

#### 主な機能

- **会話状態の追跡**: トピック履歴、感情の変化、重要ポイント
- **話題転換の検出**: スムーズな話題転換のサポート
- **未解決質問の管理**: 質問への回答状況を追跡
- **応答の一貫性チェック**: 文脈に合った応答かを検証
- **応答の強化**: 文脈を考慮した応答の改善

## ユーザーコマンド

### メモリー関連コマンド

- **「記憶を見せて」「メモリーを見せて」**: 最近の記憶を表示
- **「プロファイルを見せて」「私のことどう思ってる」**: ユーザープロファイルの要約を表示
- **「記憶をリセット」「メモリーをリセット」**: 全ての記憶とプロファイルをリセット（確認あり）
- **「記憶を検索：[検索語]」**: 特定のトピックに関する記憶を検索
- **「記憶の統計」「メモリー統計」**: 記憶の統計情報と感情傾向を表示

## データ構造

### MemoryEntry

```typescript
{
  id: string;
  userId: string;
  content: string;
  summary: string;
  analysis: ConversationAnalysis;
  context: {
    previousMessages: string[];
    noteId?: string;
    isChat: boolean;
  };
  metadata: {
    createdAt: Date;
    updatedAt: Date;
    accessCount: number;
    lastAccessedAt: Date;
    importance: number;
    category: string;
    tags: string[];
  };
}
```

### UserProfile

```typescript
{
  userId: string;
  personality: {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
  };
  preferences: {
    responseLength: string;
    formality: number;
    emotionalExpression: number;
    humor: number;
    technicalDepth: number;
    creativity: number;
  };
  interests: Array<{
    topic: string;
    score: number;
    lastMentioned: Date;
  }>;
  communicationStyle: {
    preferredGreeting: string;
    preferredFarewell: string;
    emojiUsage: string;
    responseTime: string;
  };
  statistics: {
    totalInteractions: number;
    averageMessageLength: number;
    mostActiveHours: number[];
    sentimentHistory: Array<{
      date: Date;
      sentiment: string;
    }>;
  };
}
```

## 実装の流れ

1. **会話の受信**: ユーザーからメッセージを受信
2. **分析**: LLMAnalyzerが会話を分析
3. **記憶の検索**: 関連する過去の記憶を取得
4. **プロファイル取得**: ユーザープロファイルを取得
5. **パーソナライゼーション**: 応答スタイルをカスタマイズ
6. **応答生成**: カスタマイズされたプロンプトで応答を生成
7. **記憶の保存**: 重要な情報を記憶として保存
8. **プロファイル更新**: ユーザープロファイルを更新

## メンテナンス

- **自動クリーンアップ**: 30日以上古い会話履歴と状態を自動削除
- **記憶の統合**: ユーザーごとの記憶数が上限に達すると、古い記憶を自動的に要約・統合

## 設定

メモリー機能は自動的に有効になります。特別な設定は必要ありません。

## プライバシーとセキュリティ

- すべての記憶はユーザーIDに紐付けられ、他のユーザーからはアクセスできません
- ユーザーはいつでも自分の記憶をリセットできます
- 記憶は30日後に自動的に削除されます（統合された記憶を除く）