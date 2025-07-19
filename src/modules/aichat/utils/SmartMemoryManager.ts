import loki from 'lokijs';
import { bindThis } from '@/decorators.js';
import type 藍 from '@/ai.js';
import LLMAnalyzer, { AnalysisResult } from './LLMAnalyzer.js';

export interface SmartMemory {
  id: string;
  userId: string;
  content: string;
  summary: string;
  category: string;
  importance: number;
  timestamp: number;
  lastAccessed: number;
  accessCount: number;
  tags: string[];
  relatedMemoryIds: string[];
  metadata?: Record<string, any>;
}

export interface UserProfile {
  userId: string;
  preferences: {
    communicationStyle: string;
    responseLength: string;
    emojiUsage: string;
    technicalLevel: string;
    humorAppreciation: string;
    topics: string[];
    avoidTopics: string[];
  };
  personalityProfile: {
    formality: number;
    emotiveness: number;
    verbosity: number;
    technicality: number;
    humor: number;
  };
  insights: string[];
  lastUpdated: number;
}

/**
 * LLMを活用したスマートメモリマネージャー
 */
export default class SmartMemoryManager {
  private memories: loki.Collection<SmartMemory>;
  private profiles: loki.Collection<UserProfile>;
  private ai: 藍;
  private analyzer: LLMAnalyzer;

  constructor(ai: 藍) {
    this.ai = ai;
    this.analyzer = new LLMAnalyzer();
    
    this.memories = this.ai.getCollection('smartMemories', {
      indices: ['userId', 'category', 'timestamp', 'importance']
    });
    
    this.profiles = this.ai.getCollection('userProfiles', {
      indices: ['userId']
    });
  }

  /**
   * 会話から記憶を保存
   */
  @bindThis
  public async saveFromAnalysis(
    userId: string,
    message: string,
    analysis: AnalysisResult
  ): Promise<SmartMemory | null> {
    if (!analysis.memory.shouldSave) {
      return null;
    }

    const memoryId = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // 関連する記憶を検索
    const relatedMemories = await this.findRelatedMemories(
      userId,
      analysis.memory.summary,
      analysis.memory.relatedMemories || []
    );

    const memory: SmartMemory = {
      id: memoryId,
      userId,
      content: message,
      summary: analysis.memory.summary,
      category: analysis.memory.category,
      importance: analysis.memory.importance,
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 0,
      tags: analysis.topics.keywords,
      relatedMemoryIds: relatedMemories.map(m => m.id),
      metadata: {
        sentiment: analysis.sentiment.type,
        entities: analysis.topics.entities
      }
    };

    this.memories.insertOne(memory);
    
    // 定期的に記憶を整理
    if (Math.random() < 0.1) { // 10%の確率で実行
      await this.optimizeMemories(userId);
    }

    return memory;
  }

  /**
   * 文脈に基づいて関連する記憶を取得
   */
  @bindThis
  public async getContextualMemories(
    userId: string,
    currentMessage: string,
    limit: number = 5
  ): Promise<SmartMemory[]> {
    const userMemories = this.memories.find({ userId });
    
    if (userMemories.length === 0) {
      return [];
    }

    // LLMを使用して関連性を分析
    const searchResults = await this.analyzer.searchMemories(
      currentMessage,
      userMemories.map(m => ({
        id: m.id,
        content: m.summary,
        timestamp: m.timestamp,
        tags: m.tags
      }))
    );

    // 関連性の高い順に並べ替え
    const relevantMemories = searchResults
      .filter(r => r.relevance > 0.3)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit)
      .map(r => userMemories.find(m => m.id === r.memory.id))
      .filter((memory): memory is SmartMemory => memory !== undefined);

    // アクセス情報を更新
    relevantMemories.forEach(memory => {
      memory.lastAccessed = Date.now();
      memory.accessCount++;
      this.memories.update(memory);
    });

    return relevantMemories;
  }

  /**
   * ユーザープロファイルを更新
   */
  @bindThis
  public async updateUserProfile(
    userId: string,
    interactions: Array<{
      message: string;
      response: string;
      reaction?: string;
      timestamp: number;
    }>
  ): Promise<UserProfile> {
    const existing = this.profiles.findOne({ userId });
    
    // LLMで好みを学習
    const { preferences, insights } = await this.analyzer.learnPreferences(interactions);
    
    // パーソナリティプロファイルを計算
    const personalityProfile = this.calculatePersonalityProfile(preferences);
    
    const profile: UserProfile = {
      userId,
      preferences: {
        communicationStyle: preferences.communicationStyle || existing?.preferences.communicationStyle || 'mixed',
        responseLength: preferences.responseLength || existing?.preferences.responseLength || 'medium',
        emojiUsage: preferences.emojiUsage || existing?.preferences.emojiUsage || 'moderate',
        technicalLevel: preferences.technicalLevel || existing?.preferences.technicalLevel || 'intermediate',
        humorAppreciation: preferences.humorAppreciation || existing?.preferences.humorAppreciation || 'medium',
        topics: preferences.topics || existing?.preferences.topics || [],
        avoidTopics: preferences.avoidTopics || existing?.preferences.avoidTopics || []
      },
      personalityProfile,
      insights: [...(existing?.insights || []), ...insights].slice(-10), // 最新10件の洞察を保持
      lastUpdated: Date.now()
    };

    if (existing) {
      Object.assign(existing, profile);
      this.profiles.update(existing);
    } else {
      this.profiles.insertOne(profile);
    }

    return profile;
  }

  /**
   * ユーザープロファイルを取得
   */
  @bindThis
  public getUserProfile(userId: string): UserProfile | null {
    return this.profiles.findOne({ userId });
  }

  /**
   * システムプロンプトを拡張
   */
  @bindThis
  public enhanceSystemPrompt(
    basePrompt: string,
    userId: string,
    memories: SmartMemory[],
    profile: UserProfile | null
  ): string {
    let enhancedPrompt = basePrompt;

    // 記憶情報を追加
    if (memories.length > 0) {
      enhancedPrompt += '\n\n【ユーザーに関する記憶】\n';
      memories.forEach((memory, index) => {
        enhancedPrompt += `${index + 1}. ${memory.summary}`;
        if (memory.metadata?.sentiment) {
          enhancedPrompt += ` (${memory.metadata.sentiment})`;
        }
        enhancedPrompt += '\n';
      });
    }

    // プロファイル情報を追加
    if (profile) {
      enhancedPrompt += '\n\n【ユーザーの好み】\n';
      enhancedPrompt += `- コミュニケーションスタイル: ${this.translatePreference('communicationStyle', profile.preferences.communicationStyle)}\n`;
      enhancedPrompt += `- 応答の長さ: ${this.translatePreference('responseLength', profile.preferences.responseLength)}\n`;
      enhancedPrompt += `- 絵文字の使用: ${this.translatePreference('emojiUsage', profile.preferences.emojiUsage)}\n`;
      
      if (profile.preferences.topics.length > 0) {
        enhancedPrompt += `- 興味のあるトピック: ${profile.preferences.topics.join('、')}\n`;
      }
      
      if (profile.preferences.avoidTopics.length > 0) {
        enhancedPrompt += `- 避けるべきトピック: ${profile.preferences.avoidTopics.join('、')}\n`;
      }

      // 最新の洞察を追加
      if (profile.insights.length > 0) {
        enhancedPrompt += '\n【最近の洞察】\n';
        enhancedPrompt += profile.insights.slice(-3).join('\n');
      }
    }

    return enhancedPrompt;
  }

  /**
   * 関連する記憶を検索
   */
  @bindThis
  private async findRelatedMemories(
    userId: string,
    summary: string,
    keywords: string[]
  ): Promise<SmartMemory[]> {
    const userMemories = this.memories.find({ userId });
    
    if (userMemories.length === 0) {
      return [];
    }

    // キーワードマッチングで候補を絞る
    const candidates = userMemories.filter(memory => 
      keywords.some(keyword => 
        memory.summary.includes(keyword) || 
        memory.tags.includes(keyword)
      )
    );

    if (candidates.length === 0) {
      return [];
    }

    // LLMで関連性を評価
    const results = await this.analyzer.searchMemories(
      summary,
      candidates.map(m => ({
        id: m.id,
        content: m.summary,
        timestamp: m.timestamp,
        tags: m.tags
      }))
    );

    return results
      .filter(r => r.relevance > 0.5)
      .map(r => candidates.find(c => c.id === r.memory.id)!)
      .filter(Boolean);
  }

  /**
   * 記憶の最適化
   */
  @bindThis
  private async optimizeMemories(userId: string): Promise<void> {
    const userMemories = this.memories.find({ userId });
    
    if (userMemories.length <= 500) {
      return; // 最適化不要
    }

    // 古い記憶を要約
    const oldMemories = userMemories
      .filter(m => Date.now() - m.timestamp > 30 * 24 * 60 * 60 * 1000) // 30日以上前
      .sort((a, b) => a.timestamp - b.timestamp);

    if (oldMemories.length > 100) {
      const { summary, insights, suggestedDeletions } = await this.analyzer.summarizeMemories(
        oldMemories.map(m => ({
          content: m.summary,
          timestamp: m.timestamp,
          category: m.category
        }))
      );

      // 要約を新しい記憶として保存
      if (summary) {
        this.memories.insertOne({
          id: `summary_${Date.now()}`,
          userId,
          content: 'Multiple memories summarized',
          summary,
          category: 'summary',
          importance: 0.7,
          timestamp: Date.now(),
          lastAccessed: Date.now(),
          accessCount: 0,
          tags: ['summary'],
          relatedMemoryIds: oldMemories.map(m => m.id),
          metadata: { insights }
        });
      }

      // 提案された記憶を削除
      suggestedDeletions.forEach(index => {
        if (oldMemories[index]) {
          try {
            this.memories.remove(oldMemories[index]);
          } catch (error) {
            console.error(`Failed to remove memory at index ${index}:`, error);
          }
        }
      });
    }
  }

  /**
   * パーソナリティプロファイルを計算
   */
  @bindThis
  private calculatePersonalityProfile(preferences: any): UserProfile['personalityProfile'] {
    const profile = {
      formality: 0.5,
      emotiveness: 0.5,
      verbosity: 0.5,
      technicality: 0.5,
      humor: 0.5
    };

    // コミュニケーションスタイルから推定
    if (preferences.communicationStyle === 'formal') {
      profile.formality = 0.8;
    } else if (preferences.communicationStyle === 'casual') {
      profile.formality = 0.2;
    }

    // 絵文字使用から推定
    if (preferences.emojiUsage === 'frequent') {
      profile.emotiveness = 0.8;
    } else if (preferences.emojiUsage === 'minimal') {
      profile.emotiveness = 0.2;
    }

    // 応答の長さから推定
    if (preferences.responseLength === 'long') {
      profile.verbosity = 0.8;
    } else if (preferences.responseLength === 'short') {
      profile.verbosity = 0.2;
    }

    // 技術レベルから推定
    if (preferences.technicalLevel === 'advanced') {
      profile.technicality = 0.8;
    } else if (preferences.technicalLevel === 'beginner') {
      profile.technicality = 0.2;
    }

    // ユーモアから推定
    if (preferences.humorAppreciation === 'high') {
      profile.humor = 0.8;
    } else if (preferences.humorAppreciation === 'low') {
      profile.humor = 0.2;
    }

    return profile;
  }

  /**
   * 設定値を日本語に変換
   */
  @bindThis
  private translatePreference(key: string, value: string): string {
    const translations: Record<string, Record<string, string>> = {
      communicationStyle: {
        formal: 'フォーマル',
        casual: 'カジュアル',
        mixed: 'バランス型'
      },
      responseLength: {
        short: '簡潔',
        medium: '標準',
        long: '詳細'
      },
      emojiUsage: {
        frequent: '多め',
        moderate: '適度',
        minimal: '控えめ'
      },
      technicalLevel: {
        beginner: '初心者',
        intermediate: '中級',
        advanced: '上級'
      },
      humorAppreciation: {
        low: '低',
        medium: '中',
        high: '高'
      }
    };
    return translations[key]?.[value] || value;
  }
}