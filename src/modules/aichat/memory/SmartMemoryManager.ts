import loki from 'lokijs';
import { v4 as uuid } from 'uuid';
import got from 'got';
import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import type {
  MemoryEntry,
  MemorySearchQuery,
  MemorySearchResult,
  ConversationAnalysis,
  UserProfile,
} from './types.js';

interface MemoryDoc extends MemoryEntry {
  $loki?: number;
  meta?: any;
}

export class SmartMemoryManager {
  private memories: loki.Collection<MemoryDoc>;
  private profiles: loki.Collection<UserProfile>;
  private apiKey: string;
  private model: string;
  private apiUrl: string;
  private maxMemoriesPerUser: number = 1000;
  private consolidationThreshold: number = 100; // 古い記憶を要約する閾値

  constructor(db: loki) {
    this.memories = db.getCollection('userMemories') || db.addCollection('userMemories', {
      indices: ['userId', 'id', 'metadata.category', 'metadata.importance'],
      unique: ['id'],
    });

    this.profiles = db.getCollection('userProfiles') || db.addCollection('userProfiles', {
      indices: ['userId'],
      unique: ['userId'],
    });

    this.apiKey = config.gemini?.apiKey || '';
    this.model = config.gemini?.model || 'gemini-2.5-flash';
    this.apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  }

  @bindThis
  async saveMemory(
    userId: string,
    content: string,
    analysis: ConversationAnalysis,
    context: { previousMessages: string[]; noteId?: string; isChat: boolean }
  ): Promise<MemoryEntry | null> {
    // LLMの判定に基づいて保存するかどうかを決定
    if (!analysis.memory.shouldSave) {
      return null;
    }

    const memoryEntry: MemoryEntry = {
      id: uuid(),
      userId,
      content,
      summary: analysis.memory.summary || await this.generateSummary(content),
      analysis,
      context,
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        accessCount: 0,
        lastAccessedAt: new Date(),
        importance: analysis.memory.importance,
        category: analysis.memory.category,
        tags: analysis.memory.tags,
      },
    };

    // ユーザーの記憶数をチェック
    const userMemories = this.memories.find({ userId });
    if (userMemories.length >= this.maxMemoriesPerUser) {
      // 古い記憶を整理
      await this.consolidateOldMemories(userId);
    }

    this.memories.insert(memoryEntry);
    
    // ユーザープロファイルを更新
    await this.updateUserProfile(userId, analysis);

    return memoryEntry;
  }

  @bindThis
  async searchMemories(query: MemorySearchQuery): Promise<MemorySearchResult> {
    let searchQuery: any = { userId: query.userId };

    if (query.category) {
      searchQuery['metadata.category'] = query.category;
    }

    if (query.minImportance !== undefined) {
      searchQuery['metadata.importance'] = { $gte: query.minImportance };
    }

    let memories = this.memories.find(searchQuery);

    // 日付範囲でフィルタリング
    if (query.dateRange) {
      memories = memories.filter(m => {
        const createdAt = new Date(m.metadata.createdAt);
        return createdAt >= query.dateRange!.start && createdAt <= query.dateRange!.end;
      });
    }

    // タグでフィルタリング
    if (query.tags && query.tags.length > 0) {
      memories = memories.filter(m => 
        query.tags!.some(tag => m.metadata.tags.includes(tag))
      );
    }

    // クエリテキストがある場合は、LLMを使って関連性を評価
    let relevanceScores: number[] = [];
    if (query.query) {
      const scoredMemories = await this.scoreMemoriesByRelevance(memories, query.query);
      memories = scoredMemories.memories;
      relevanceScores = scoredMemories.scores;
    }

    // 重要度とアクセス頻度でソート
    memories.sort((a, b) => {
      const scoreA = a.metadata.importance + (a.metadata.accessCount / 100);
      const scoreB = b.metadata.importance + (b.metadata.accessCount / 100);
      return scoreB - scoreA;
    });

    // 制限を適用
    if (query.limit) {
      memories = memories.slice(0, query.limit);
      relevanceScores = relevanceScores.slice(0, query.limit);
    }

    // アクセスカウントを更新
    memories.forEach(memory => {
      memory.metadata.accessCount++;
      memory.metadata.lastAccessedAt = new Date();
      this.memories.update(memory);
    });

    // カテゴリとタグを集計
    const categories = [...new Set(memories.map(m => m.metadata.category))];
    const allTags = memories.flatMap(m => m.metadata.tags);
    const commonTags = this.getCommonElements(allTags);

    return {
      entries: memories,
      relevanceScores,
      totalCount: memories.length,
      categories,
      commonTags,
    };
  }

  @bindThis
  async getRelatedMemories(userId: string, currentContext: string, limit: number = 5): Promise<MemoryEntry[]> {
    const prompt = `以下の現在の会話文脈に最も関連する記憶を選んでください。

現在の文脈:
${currentContext}

利用可能な記憶:
${this.memories.find({ userId }).map((m, i) => `
[${i}] ${m.summary}
カテゴリ: ${m.metadata.category}
タグ: ${m.metadata.tags.join(', ')}
`).join('\n')}

最も関連性の高い記憶のインデックス番号を最大${limit}個、JSON配列形式で返してください。
例: [0, 3, 5]`;

    try {
      const response = await this.callGeminiAPI(prompt);
      const indices = JSON.parse(response);
      const allMemories = this.memories.find({ userId });
      
      return indices
        .filter((i: number) => i >= 0 && i < allMemories.length)
        .map((i: number) => allMemories[i]);
    } catch (error) {
      console.error('Error getting related memories:', error);
      // フォールバック: 最新の記憶を返す
      return this.memories
        .chain()
        .find({ userId })
        .simplesort('metadata.createdAt', true)
        .limit(limit)
        .data();
    }
  }

  @bindThis
  async generateUserProfileSummary(userId: string): Promise<string> {
    const profile = this.profiles.findOne({ userId });
    if (!profile) {
      return 'まだプロファイル情報がありません。';
    }

    const memories = this.memories
      .chain()
      .find({ userId })
      .simplesort('metadata.importance', true)
      .limit(20)
      .data();

    const prompt = `以下のユーザープロファイルと記憶情報から、ユーザーの総合的な特徴を日本語で要約してください。

プロファイル:
性格特性:
- 開放性: ${profile.personality.openness}
- 誠実性: ${profile.personality.conscientiousness}
- 外向性: ${profile.personality.extraversion}
- 協調性: ${profile.personality.agreeableness}
- 神経症傾向: ${profile.personality.neuroticism}

コミュニケーション好み:
- 応答の長さ: ${profile.preferences.responseLength}
- フォーマル度: ${profile.preferences.formality}
- 感情表現: ${profile.preferences.emotionalExpression}
- ユーモア: ${profile.preferences.humor}

興味のあるトピック:
${profile.interests.slice(0, 5).map(i => `- ${i.topic} (スコア: ${i.score})`).join('\n')}

重要な記憶:
${memories.map(m => `- ${m.summary}`).join('\n')}

200文字以内で要約してください。`;

    try {
      const response = await this.callGeminiAPI(prompt);
      return response;
    } catch (error) {
      console.error('Error generating profile summary:', error);
      return 'プロファイルの要約生成に失敗しました。';
    }
  }

  @bindThis
  private async consolidateOldMemories(userId: string): Promise<void> {
    const oldMemories = this.memories
      .chain()
      .find({ userId })
      .simplesort('metadata.createdAt')
      .limit(this.consolidationThreshold)
      .data();

    if (oldMemories.length === 0) return;

    const summaryPrompt = `以下の古い記憶を1つの要約にまとめてください。重要な情報は保持し、冗長な部分は削除してください。

記憶リスト:
${oldMemories.map(m => `- ${m.summary}`).join('\n')}

100文字以内で要約してください。`;

    try {
      const consolidatedSummary = await this.callGeminiAPI(summaryPrompt);
      
      // 統合された記憶を作成
      const consolidatedMemory: MemoryEntry = {
        id: uuid(),
        userId,
        content: `[統合された記憶: ${oldMemories.length}件の記憶から生成]`,
        summary: consolidatedSummary,
        analysis: oldMemories[0].analysis, // 最初の記憶の分析を使用
        context: {
          previousMessages: [],
          isChat: false,
        },
        metadata: {
          createdAt: oldMemories[0].metadata.createdAt,
          updatedAt: new Date(),
          accessCount: oldMemories.reduce((sum, m) => sum + m.metadata.accessCount, 0),
          lastAccessedAt: new Date(),
          importance: Math.max(...oldMemories.map(m => m.metadata.importance)),
          category: '統合記憶',
          tags: [...new Set(oldMemories.flatMap(m => m.metadata.tags))],
        },
      };

      // 古い記憶を削除
      oldMemories.forEach(m => this.memories.remove(m));
      
      // 統合された記憶を保存
      this.memories.insert(consolidatedMemory);
    } catch (error) {
      console.error('Error consolidating memories:', error);
    }
  }

  @bindThis
  private async updateUserProfile(userId: string, analysis: ConversationAnalysis): Promise<void> {
    let profile = this.profiles.findOne({ userId });
    
    if (!profile) {
      // 新規プロファイルを作成
      profile = this.createDefaultProfile(userId);
      this.profiles.insert(profile);
    }

    // 性格特性を更新（加重平均）
    const weight = 0.1; // 新しい分析の重み
    profile.personality.openness = this.updateValue(
      profile.personality.openness,
      analysis.personalization.preferredStyle.creativity,
      weight
    );
    profile.personality.conscientiousness = this.updateValue(
      profile.personality.conscientiousness,
      1 - analysis.personalization.preferredStyle.creativity,
      weight
    );
    profile.personality.extraversion = this.updateValue(
      profile.personality.extraversion,
      analysis.personalization.preferredStyle.emotionalExpression,
      weight
    );
    profile.personality.agreeableness = this.updateValue(
      profile.personality.agreeableness,
      analysis.emotion.emotions.love,
      weight
    );
    profile.personality.neuroticism = this.updateValue(
      profile.personality.neuroticism,
      (analysis.emotion.emotions.fear + analysis.emotion.emotions.anger) / 2,
      weight
    );

    // コミュニケーション好みを更新
    profile.preferences.formality = this.updateValue(
      profile.preferences.formality,
      analysis.personalization.preferredStyle.formality,
      weight
    );
    profile.preferences.emotionalExpression = this.updateValue(
      profile.preferences.emotionalExpression,
      analysis.personalization.preferredStyle.emotionalExpression,
      weight
    );
    profile.preferences.humor = this.updateValue(
      profile.preferences.humor,
      analysis.personalization.preferredStyle.humor,
      weight
    );
    profile.preferences.technicalDepth = this.updateValue(
      profile.preferences.technicalDepth,
      analysis.personalization.preferredStyle.technicalDepth,
      weight
    );
    profile.preferences.creativity = this.updateValue(
      profile.preferences.creativity,
      analysis.personalization.preferredStyle.creativity,
      weight
    );

    // 興味のあるトピックを更新
    const existingTopic = profile.interests.find(i => i.topic === analysis.topic.mainTopic);
    if (existingTopic) {
      existingTopic.score = Math.min(1, existingTopic.score + 0.1);
      existingTopic.lastMentioned = new Date();
    } else {
      profile.interests.push({
        topic: analysis.topic.mainTopic,
        score: 0.3,
        lastMentioned: new Date(),
      });
    }

    // 興味をスコアでソート
    profile.interests.sort((a, b) => b.score - a.score);
    
    // 統計情報を更新
    profile.statistics.totalInteractions++;
    profile.statistics.sentimentHistory.push({
      date: new Date(),
      sentiment: analysis.emotion.sentiment,
    });

    // 古い感情履歴を削除（最新100件のみ保持）
    if (profile.statistics.sentimentHistory.length > 100) {
      profile.statistics.sentimentHistory = profile.statistics.sentimentHistory.slice(-100);
    }

    profile.updatedAt = new Date();
    this.profiles.update(profile);
  }

  @bindThis
  private async scoreMemoriesByRelevance(
    memories: MemoryEntry[],
    query: string
  ): Promise<{ memories: MemoryEntry[]; scores: number[] }> {
    if (memories.length === 0) {
      return { memories: [], scores: [] };
    }

    const prompt = `以下のクエリに対する各記憶の関連性を0-1のスコアで評価してください。

クエリ: ${query}

記憶リスト:
${memories.map((m, i) => `[${i}] ${m.summary}`).join('\n')}

JSON配列形式でスコアを返してください。
例: [0.8, 0.3, 0.9, ...]`;

    try {
      const response = await this.callGeminiAPI(prompt);
      const scores = JSON.parse(response);
      
      // スコアでソート
      const sorted = memories
        .map((m, i) => ({ memory: m, score: scores[i] || 0 }))
        .sort((a, b) => b.score - a.score)
        .filter(item => item.score > 0.3); // 関連性の低いものを除外

      return {
        memories: sorted.map(item => item.memory),
        scores: sorted.map(item => item.score),
      };
    } catch (error) {
      console.error('Error scoring memories:', error);
      return { memories, scores: memories.map(() => 0.5) };
    }
  }

  @bindThis
  private async generateSummary(content: string): Promise<string> {
    const prompt = `以下の内容を50文字以内で要約してください：\n\n${content}`;
    
    try {
      const response = await this.callGeminiAPI(prompt);
      return response.substring(0, 50);
    } catch (error) {
      console.error('Error generating summary:', error);
      return content.substring(0, 50);
    }
  }

  @bindThis
  private async callGeminiAPI(prompt: string): Promise<string> {
    const requestBody = {
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.3,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024,
      }
    };

    const response = await got.post(this.apiUrl, {
      searchParams: { key: this.apiKey },
      json: requestBody,
      timeout: { request: 30000 },
    }).json<any>();

    return response.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  @bindThis
  private createDefaultProfile(userId: string): UserProfile {
    return {
      userId,
      personality: {
        openness: 0.5,
        conscientiousness: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        neuroticism: 0.5,
      },
      preferences: {
        responseLength: 'moderate',
        formality: 0.5,
        emotionalExpression: 0.5,
        humor: 0.3,
        technicalDepth: 0.5,
        creativity: 0.5,
      },
      interests: [],
      communicationStyle: {
        preferredGreeting: 'こんにちは',
        preferredFarewell: 'またね',
        emojiUsage: 'sometimes',
        responseTime: 'thoughtful',
      },
      statistics: {
        totalInteractions: 0,
        averageMessageLength: 0,
        mostActiveHours: [],
        sentimentHistory: [],
      },
      updatedAt: new Date(),
    };
  }

  @bindThis
  private updateValue(oldValue: number, newValue: number, weight: number): number {
    return oldValue * (1 - weight) + newValue * weight;
  }

  @bindThis
  private getCommonElements(arr: string[]): string[] {
    const counts = arr.reduce((acc, item) => {
      acc[item] = (acc[item] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([item]) => item);
  }

  @bindThis
  getUserProfile(userId: string): UserProfile | null {
    return this.profiles.findOne({ userId });
  }

  @bindThis
  resetUserMemories(userId: string): boolean {
    try {
      // ユーザーの全ての記憶を削除
      const userMemories = this.memories.find({ userId });
      userMemories.forEach(memory => this.memories.remove(memory));
      
      // ユーザープロファイルをリセット
      const profile = this.profiles.findOne({ userId });
      if (profile) {
        this.profiles.remove(profile);
      }
      
      return true;
    } catch (error) {
      console.error('Error resetting user memories:', error);
      return false;
    }
  }
}