import loki from 'lokijs';
import { bindThis } from '@/decorators.js';
import type 藍 from '@/ai.js';

export interface UserMemory {
  userId: string;
  topic: string;
  content: string;
  importance: number; // 0-1の重要度スコア
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  tags: string[];
  relatedMemories?: string[]; // 関連する記憶のID
  embedding?: number[]; // 将来的なベクトル検索用
}

export interface UserPreference {
  userId: string;
  category: string;
  preference: string;
  confidence: number; // 0-1の確信度
  updatedAt: number;
  evidenceCount: number;
}

export interface ConversationTopic {
  userId: string;
  topicId: string;
  topic: string;
  keywords: string[];
  startedAt: number;
  lastActiveAt: number;
  messageCount: number;
  sentiment: 'positive' | 'neutral' | 'negative';
}

/**
 * ユーザーごとの長期記憶を管理するクラス
 */
export default class MemoryManager {
  private memories: loki.Collection<UserMemory>;
  private preferences: loki.Collection<UserPreference>;
  private topics: loki.Collection<ConversationTopic>;
  private ai: 藍;

  constructor(ai: 藍) {
    this.ai = ai;
    this.memories = this.ai.getCollection('userMemories', {
      indices: ['userId', 'topic', 'createdAt', 'importance']
    });
    this.preferences = this.ai.getCollection('userPreferences', {
      indices: ['userId', 'category']
    });
    this.topics = this.ai.getCollection('conversationTopics', {
      indices: ['userId', 'topicId', 'lastActiveAt']
    });
  }

  /**
   * 重要な情報を記憶として保存
   */
  @bindThis
  public async saveMemory(
    userId: string,
    content: string,
    topic: string,
    importance: number = 0.5,
    tags: string[] = []
  ): Promise<UserMemory> {
    const memory = this.memories.insertOne({
      userId,
      topic,
      content,
      importance,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      tags
    });

    // 古い記憶の整理（ユーザーごとに最大1000件）
    await this.pruneOldMemories(userId);

    return memory!;
  }

  /**
   * 関連する記憶を検索
   */
  @bindThis
  public async searchMemories(
    userId: string,
    query: string,
    limit: number = 5
  ): Promise<UserMemory[]> {
    // キーワードベースの検索
    const keywords = this.extractKeywords(query);
    
    const memories = this.memories.find({
      userId,
      $or: [
        { topic: { $regex: new RegExp(keywords.join('|'), 'i') } },
        { content: { $regex: new RegExp(keywords.join('|'), 'i') } },
        { tags: { $in: keywords } }
      ]
    });

    // 重要度とアクセス頻度でソート
    memories.sort((a, b) => {
      const scoreA = a.importance * 0.7 + (a.accessCount / 100) * 0.3;
      const scoreB = b.importance * 0.7 + (b.accessCount / 100) * 0.3;
      return scoreB - scoreA;
    });

    // アクセスカウントを更新
    memories.slice(0, limit).forEach(memory => {
      memory.lastAccessedAt = Date.now();
      memory.accessCount++;
      this.memories.update(memory);
    });

    return memories.slice(0, limit);
  }

  /**
   * ユーザーの好みを学習・更新
   */
  @bindThis
  public async updatePreference(
    userId: string,
    category: string,
    preference: string,
    positive: boolean = true
  ): Promise<void> {
    const existing = this.preferences.findOne({ userId, category, preference });

    if (existing) {
      // 既存の好みを更新
      existing.confidence = Math.min(1, existing.confidence + (positive ? 0.1 : -0.1));
      existing.confidence = Math.max(0, existing.confidence);
      existing.evidenceCount++;
      existing.updatedAt = Date.now();
      this.preferences.update(existing);
    } else {
      // 新しい好みを追加
      this.preferences.insertOne({
        userId,
        category,
        preference,
        confidence: positive ? 0.6 : 0.4,
        updatedAt: Date.now(),
        evidenceCount: 1
      });
    }
  }

  /**
   * ユーザーの好みを取得
   */
  @bindThis
  public getPreferences(userId: string, category?: string): UserPreference[] {
    const query: any = { userId, confidence: { $gte: 0.5 } };
    if (category) query.category = category;

    return this.preferences.find(query).sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 会話のトピックを追跡
   */
  @bindThis
  public async trackTopic(
    userId: string,
    message: string,
    sentiment: 'positive' | 'neutral' | 'negative' = 'neutral'
  ): Promise<ConversationTopic | null> {
    const keywords = this.extractKeywords(message);
    if (keywords.length === 0) return null;

    // 既存のアクティブなトピックを探す
    const recentTopics = this.topics.find({
      userId,
      lastActiveAt: { $gte: Date.now() - 30 * 60 * 1000 } // 30分以内
    });

    let matchedTopic = null;
    for (const topic of recentTopics) {
      if (topic.keywords.some(kw => keywords.includes(kw))) {
        matchedTopic = topic;
        break;
      }
    }

    if (matchedTopic) {
      // 既存のトピックを更新
      matchedTopic.keywords = [...new Set([...matchedTopic.keywords, ...keywords])];
      matchedTopic.lastActiveAt = Date.now();
      matchedTopic.messageCount++;
      matchedTopic.sentiment = sentiment;
      this.topics.update(matchedTopic);
      return matchedTopic;
    } else {
      // 新しいトピックを作成
      const topicId = `topic_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const newTopic = this.topics.insertOne({
        userId,
        topicId,
        topic: keywords[0], // 最初のキーワードをトピック名に
        keywords,
        startedAt: Date.now(),
        lastActiveAt: Date.now(),
        messageCount: 1,
        sentiment
      });
      return newTopic!;
    }
  }

  /**
   * 会話の文脈を構築
   */
  @bindThis
  public async buildContext(userId: string, currentMessage: string): Promise<{
    memories: UserMemory[];
    preferences: UserPreference[];
    currentTopic?: ConversationTopic;
    relatedTopics: ConversationTopic[];
  }> {
    // 関連する記憶を検索
    const memories = await this.searchMemories(userId, currentMessage, 3);

    // ユーザーの好みを取得
    const preferences = this.getPreferences(userId);

    // 現在のトピックを追跡
    const currentTopic = await this.trackTopic(userId, currentMessage);

    // 関連するトピックを取得
    const relatedTopics = currentTopic
      ? this.topics.find({
          userId,
          topicId: { $ne: currentTopic.topicId },
          keywords: { $in: currentTopic.keywords }
        }).slice(0, 3)
      : [];

    return {
      memories,
      preferences,
      currentTopic,
      relatedTopics
    };
  }

  /**
   * キーワード抽出（簡易版）
   */
  @bindThis
  private extractKeywords(text: string): string[] {
    // 簡易的なキーワード抽出
    // 実際の実装では形態素解析を使用
    const stopWords = ['の', 'は', 'が', 'を', 'に', 'で', 'と', 'から', 'まで', 'や', 'も'];
    const words = text.split(/[\s、。！？\n]+/)
      .filter(word => word.length > 1)
      .filter(word => !stopWords.includes(word));

    // 重要そうな単語を抽出（カタカナ、漢字を含む単語を優先）
    return words.filter(word => 
      /[\u30A0-\u30FF]/.test(word) || // カタカナ
      /[\u4E00-\u9FAF]/.test(word) || // 漢字
      /[A-Z]/.test(word) // 英大文字
    ).slice(0, 5);
  }

  /**
   * 古い記憶を整理
   */
  @bindThis
  private async pruneOldMemories(userId: string): Promise<void> {
    const userMemories = this.memories.find({ userId });
    
    if (userMemories.length > 1000) {
      // 重要度が低く、アクセスされていない記憶を削除
      userMemories.sort((a, b) => {
        const scoreA = a.importance * 0.5 + (a.accessCount / 100) * 0.3 + (a.lastAccessedAt / Date.now()) * 0.2;
        const scoreB = b.importance * 0.5 + (b.accessCount / 100) * 0.3 + (b.lastAccessedAt / Date.now()) * 0.2;
        return scoreA - scoreB;
      });

      const toDelete = userMemories.slice(0, userMemories.length - 1000);
      toDelete.forEach(memory => this.memories.remove(memory));
    }
  }

  /**
   * 記憶の重要度を再計算
   */
  @bindThis
  public async recalculateImportance(userId: string): Promise<void> {
    const memories = this.memories.find({ userId });
    
    memories.forEach(memory => {
      // 時間経過による減衰
      const ageInDays = (Date.now() - memory.createdAt) / (1000 * 60 * 60 * 24);
      const ageFactor = Math.exp(-ageInDays / 30); // 30日で約37%に減衰

      // アクセス頻度による加算
      const accessFactor = Math.min(1, memory.accessCount / 10);

      // 新しい重要度を計算
      memory.importance = memory.importance * 0.5 + ageFactor * 0.3 + accessFactor * 0.2;
      this.memories.update(memory);
    });
  }
}