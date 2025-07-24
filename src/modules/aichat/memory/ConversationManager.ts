import loki from 'lokijs';
import { bindThis } from '@/decorators.js';
import type {
  ConversationState,
  ConversationAnalysis,
  EmotionAnalysis,
  MemoryEntry,
} from './types.js';

interface ConversationStateDoc extends ConversationState {
  $loki?: number;
  meta?: any;
}

interface ConversationContext {
  userId: string;
  currentMessage: string;
  previousMessages: string[];
  analysis: ConversationAnalysis;
  relatedMemories: MemoryEntry[];
}

export class ConversationManager {
  private conversationStates: loki.Collection<ConversationStateDoc>;
  private readonly topicTransitionThreshold = 0.3; // トピック変更の閾値
  private readonly emotionalStabilityWindow = 5; // 感情安定性を評価するメッセージ数

  constructor(db: loki) {
    this.conversationStates = db.getCollection('conversationStates') || 
      db.addCollection('conversationStates', {
        indices: ['userId'],
        unique: ['userId'],
      });
  }

  @bindThis
  async updateConversationState(
    context: ConversationContext
  ): Promise<ConversationState> {
    const { userId, analysis } = context;
    
    let state = this.conversationStates.findOne({ userId });
    
    if (!state) {
      state = this.createNewConversationState(userId, analysis);
      this.conversationStates.insert(state);
    } else {
      this.updateExistingState(state, analysis);
      this.conversationStates.update(state);
    }

    return state;
  }

  @bindThis
  detectTopicTransition(
    currentTopic: string,
    previousTopic: string,
    keywords: string[]
  ): boolean {
    if (!previousTopic || previousTopic === currentTopic) {
      return false;
    }

    // キーワードの重複をチェック
    const previousKeywords = previousTopic.split(/[、。\s]+/);
    const overlap = keywords.filter(kw => 
      previousKeywords.some(pk => pk.includes(kw) || kw.includes(pk))
    ).length;

    const overlapRatio = overlap / Math.max(keywords.length, previousKeywords.length);
    
    return overlapRatio < this.topicTransitionThreshold;
  }

  @bindThis
  trackUnresolvedQuestions(
    state: ConversationState,
    analysis: ConversationAnalysis,
    message: string
  ): void {
    // 質問が検出された場合
    if (analysis.intent.type === 'question') {
      state.unresolvedQuestions.push({
        question: message,
        askedAt: new Date(),
        context: state.currentTopic,
      });
    }

    // 古い未解決の質問を削除（24時間以上経過）
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    state.unresolvedQuestions = state.unresolvedQuestions.filter(
      q => q.askedAt > oneDayAgo
    );
  }

  @bindThis
  analyzeEmotionalJourney(state: ConversationState): {
    trend: 'improving' | 'declining' | 'stable';
    volatility: number;
    dominantEmotion: string;
  } {
    const recentEmotions = state.emotionalJourney.slice(-this.emotionalStabilityWindow);
    
    if (recentEmotions.length < 2) {
      return {
        trend: 'stable',
        volatility: 0,
        dominantEmotion: 'neutral',
      };
    }

    // 感情のトレンドを分析
    const sentiments = recentEmotions.map(e => {
      switch (e.emotion.sentiment) {
        case 'positive': return 1;
        case 'negative': return -1;
        default: return 0;
      }
    });

    const trend = this.calculateTrend(sentiments);
    const volatility = this.calculateVolatility(sentiments);
    const dominantEmotion = this.findDominantEmotion(recentEmotions);

    return {
      trend: trend > 0.2 ? 'improving' : trend < -0.2 ? 'declining' : 'stable',
      volatility,
      dominantEmotion,
    };
  }

  @bindThis
  extractKeyPoints(
    analysis: ConversationAnalysis,
    message: string
  ): string[] {
    const keyPoints: string[] = [];

    // 重要な意図を持つメッセージ
    if (analysis.intent.type === 'request' || analysis.intent.type === 'question') {
      keyPoints.push(`${analysis.intent.type}: ${analysis.memory.summary}`);
    }

    // 強い感情を含むメッセージ
    const strongEmotions = Object.entries(analysis.emotion.emotions)
      .filter(([_, value]) => value > 0.7)
      .map(([emotion]) => emotion);
    
    if (strongEmotions.length > 0) {
      keyPoints.push(`感情表現: ${strongEmotions.join(', ')}`);
    }

    // 重要なエンティティ
    const allEntities = [
      ...analysis.topic.entities.people,
      ...analysis.topic.entities.places,
      ...analysis.topic.entities.organizations,
      ...analysis.topic.entities.products,
      ...analysis.topic.entities.events,
    ];
    
    if (allEntities.length > 0) {
      keyPoints.push(`言及: ${allEntities.slice(0, 3).join(', ')}`);
    }

    return keyPoints;
  }

  @bindThis
  generateConversationSummary(state: ConversationState): string {
    const emotionalJourney = this.analyzeEmotionalJourney(state);
    const recentTopics = state.topicHistory.slice(-5).map(t => t.topic);
    const unresolvedCount = state.unresolvedQuestions.length;

    let summary = `会話の概要:\n`;
    summary += `- 現在のトピック: ${state.currentTopic}\n`;
    summary += `- 最近のトピック: ${recentTopics.join('、')}\n`;
    summary += `- 感情の傾向: ${this.translateEmotionalTrend(emotionalJourney.trend)}\n`;
    summary += `- 主な感情: ${this.translateEmotion(emotionalJourney.dominantEmotion)}\n`;
    
    if (unresolvedCount > 0) {
      summary += `- 未解決の質問: ${unresolvedCount}件\n`;
    }

    if (state.keyPoints.length > 0) {
      summary += `- 重要ポイント:\n`;
      state.keyPoints.slice(-5).forEach(point => {
        summary += `  ・${point}\n`;
      });
    }

    return summary;
  }

  @bindThis
  shouldAdjustResponseStyle(state: ConversationState): {
    shouldAdjust: boolean;
    reason: string;
    suggestions: string[];
  } {
    const emotionalAnalysis = this.analyzeEmotionalJourney(state);
    const suggestions: string[] = [];
    let shouldAdjust = false;
    let reason = '';

    // 感情が不安定な場合
    if (emotionalAnalysis.volatility > 0.7) {
      shouldAdjust = true;
      reason = '感情の変化が激しい';
      suggestions.push('より安定した落ち着いたトーンで応答する');
    }

    // 感情が悪化している場合
    if (emotionalAnalysis.trend === 'declining') {
      shouldAdjust = true;
      reason = '感情が悪化傾向';
      suggestions.push('より共感的で支援的な応答をする');
      suggestions.push('ポジティブな要素を含める');
    }

    // 長時間同じトピックの場合
    const currentTopicDuration = this.getTopicDuration(state);
    if (currentTopicDuration > 30 * 60 * 1000) { // 30分以上
      shouldAdjust = true;
      reason = '同じトピックが長時間続いている';
      suggestions.push('新しい視点や関連トピックを提案する');
    }

    // 未解決の質問が多い場合
    if (state.unresolvedQuestions.length > 3) {
      shouldAdjust = true;
      reason = '未解決の質問が蓄積している';
      suggestions.push('過去の質問に対する回答を含める');
    }

    return { shouldAdjust, reason, suggestions };
  }

  @bindThis
  private createNewConversationState(
    userId: string,
    analysis: ConversationAnalysis
  ): ConversationState {
    return {
      userId,
      currentTopic: analysis.topic.mainTopic,
      topicHistory: [{
        topic: analysis.topic.mainTopic,
        startedAt: new Date(),
      }],
      emotionalJourney: [{
        timestamp: new Date(),
        emotion: analysis.emotion,
      }],
      unresolvedQuestions: [],
      keyPoints: [],
      lastInteraction: new Date(),
    };
  }

  @bindThis
  private updateExistingState(
    state: ConversationState,
    analysis: ConversationAnalysis
  ): void {
    // トピックの更新
    if (this.detectTopicTransition(
      analysis.topic.mainTopic,
      state.currentTopic,
      analysis.topic.keywords
    )) {
      // 現在のトピックを終了
      const currentTopicEntry = state.topicHistory[state.topicHistory.length - 1];
      if (currentTopicEntry && !currentTopicEntry.endedAt) {
        currentTopicEntry.endedAt = new Date();
      }

      // 新しいトピックを開始
      state.topicHistory.push({
        topic: analysis.topic.mainTopic,
        startedAt: new Date(),
      });
      state.currentTopic = analysis.topic.mainTopic;
    }

    // 感情の記録
    state.emotionalJourney.push({
      timestamp: new Date(),
      emotion: analysis.emotion,
    });

    // 古い感情記録を削除（最新100件のみ保持）
    if (state.emotionalJourney.length > 100) {
      state.emotionalJourney = state.emotionalJourney.slice(-100);
    }

    // キーポイントの追加
    const newKeyPoints = this.extractKeyPoints(analysis, '');
    state.keyPoints.push(...newKeyPoints);

    // 古いキーポイントを削除（最新50件のみ保持）
    if (state.keyPoints.length > 50) {
      state.keyPoints = state.keyPoints.slice(-50);
    }

    state.lastInteraction = new Date();
  }

  @bindThis
  private calculateTrend(values: number[]): number {
    if (values.length < 2) return 0;

    let sum = 0;
    for (let i = 1; i < values.length; i++) {
      sum += values[i] - values[i - 1];
    }
    return sum / (values.length - 1);
  }

  @bindThis
  private calculateVolatility(values: number[]): number {
    if (values.length < 2) return 0;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  @bindThis
  private findDominantEmotion(emotionalJourney: { emotion: EmotionAnalysis }[]): string {
    const emotionSums: Record<string, number> = {
      joy: 0,
      sadness: 0,
      anger: 0,
      fear: 0,
      surprise: 0,
      love: 0,
    };

    emotionalJourney.forEach(entry => {
      Object.entries(entry.emotion.emotions).forEach(([emotion, value]) => {
        emotionSums[emotion] += value;
      });
    });

    const dominantEmotion = Object.entries(emotionSums)
      .sort(([, a], [, b]) => b - a)[0];

    return dominantEmotion[0];
  }

  @bindThis
  private getTopicDuration(state: ConversationState): number {
    const currentTopic = state.topicHistory[state.topicHistory.length - 1];
    if (!currentTopic) return 0;

    return Date.now() - currentTopic.startedAt.getTime();
  }

  @bindThis
  private translateEmotionalTrend(trend: string): string {
    const translations: Record<string, string> = {
      improving: '改善傾向',
      declining: '悪化傾向',
      stable: '安定',
    };
    return translations[trend] || trend;
  }

  @bindThis
  private translateEmotion(emotion: string): string {
    const translations: Record<string, string> = {
      joy: '喜び',
      sadness: '悲しみ',
      anger: '怒り',
      fear: '恐れ',
      surprise: '驚き',
      love: '愛情',
      neutral: '中立',
    };
    return translations[emotion] || emotion;
  }

  @bindThis
  getConversationState(userId: string): ConversationState | null {
    return this.conversationStates.findOne({ userId });
  }

  @bindThis
  clearOldConversations(daysToKeep: number = 30): number {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const oldStates = this.conversationStates.find({
      lastInteraction: { $lt: cutoffDate },
    });

    oldStates.forEach(state => this.conversationStates.remove(state));
    return oldStates.length;
  }
}