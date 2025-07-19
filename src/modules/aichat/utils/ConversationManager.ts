import { bindThis } from '@/decorators.js';
import type 藍 from '@/ai.js';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';
import config from '@/config.js';
import LLMAnalyzer, { AnalysisResult } from './LLMAnalyzer.js';
import { randomUUID } from 'crypto';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  metadata?: {
    sentiment?: string;
    topic?: string;
    intent?: string;
    entities?: any[];
  };
}

export interface ConversationState {
  userId: string;
  conversationId: string;
  turns: ConversationTurn[];
  currentTopic?: string;
  topicHistory: Array<{ topic: string; startTime: number; endTime?: number }>;
  emotionalArc: Array<{ sentiment: string; timestamp: number }>;
  keyPoints: string[];
  unresolved: string[];
  context: Record<string, any>;
}

export interface ConversationSummary {
  mainTopics: string[];
  emotionalJourney: string;
  keyDecisions: string[];
  actionItems: string[];
  unresolvedQuestions: string[];
}

/**
 * 会話の流れと文脈を管理するマネージャー
 */
export default class ConversationManager {
  private ai: 藍;
  private analyzer: LLMAnalyzer;
  private llm: ChatGoogleGenerativeAI;
  private conversations: Map<string, ConversationState>;
  private maxTurnsInMemory: number = 50;

  constructor(ai: 藍) {
    this.ai = ai;
    this.analyzer = new LLMAnalyzer();
    this.conversations = new Map();

    const apiKey = config.gemini?.apiKey || '';
    if (!apiKey) {
      console.warn('Gemini API key is not configured. ConversationManager features will be disabled.');
    }

    this.llm = new ChatGoogleGenerativeAI({
      model: config.gemini?.model || 'gemini-2.5-flash',
      apiKey: apiKey,
      temperature: 0.3,
    });

    // 定期的に古い会話をクリーンアップ
    setInterval(() => this.cleanupOldConversations(), 60 * 60 * 1000); // 1時間ごと
  }

  /**
   * 新しい会話を開始
   */
  @bindThis
  public startConversation(userId: string): string {
    const conversationId = `conv_${randomUUID()}`;
    
    const state: ConversationState = {
      userId,
      conversationId,
      turns: [],
      topicHistory: [],
      emotionalArc: [],
      keyPoints: [],
      unresolved: [],
      context: {},
    };

    this.conversations.set(conversationId, state);
    return conversationId;
  }

  /**
   * 会話にターンを追加
   */
  @bindThis
  public async addTurn(
    conversationId: string,
    turn: ConversationTurn,
    analysis?: AnalysisResult
  ): Promise<void> {
    const state = this.conversations.get(conversationId);
    if (!state) return;

    // メタデータを追加
    if (analysis) {
      turn.metadata = {
        sentiment: analysis.sentiment.type,
        topic: analysis.topics.main,
        intent: analysis.intent.type,
        entities: analysis.topics.entities,
      };
    }

    state.turns.push(turn);

    // 会話の状態を更新
    await this.updateConversationState(state, turn, analysis);

    // ターン数が上限を超えたら古いものを削除
    if (state.turns.length > this.maxTurnsInMemory) {
      state.turns = state.turns.slice(-this.maxTurnsInMemory);
    }
  }

  /**
   * 会話の文脈を取得
   */
  @bindThis
  public getConversationContext(conversationId: string): {
    recentTurns: ConversationTurn[];
    currentTopic: string | undefined;
    emotionalState: string | undefined;
    keyPoints: string[];
    unresolved: string[];
  } | null {
    const state = this.conversations.get(conversationId);
    if (!state) return null;

    const recentEmotions = state.emotionalArc.slice(-3);
    const currentEmotion = recentEmotions.length > 0 
      ? recentEmotions[recentEmotions.length - 1].sentiment 
      : undefined;

    return {
      recentTurns: state.turns.slice(-10), // 最新10ターン
      currentTopic: state.currentTopic,
      emotionalState: currentEmotion,
      keyPoints: state.keyPoints.slice(-5), // 最新5つの重要ポイント
      unresolved: state.unresolved,
    };
  }

  /**
   * 会話の要約を生成
   */
  @bindThis
  public async generateSummary(conversationId: string): Promise<ConversationSummary | null> {
    const state = this.conversations.get(conversationId);
    if (!state || state.turns.length === 0) return null;

    const prompt = PromptTemplate.fromTemplate(`
以下の会話を分析し、要約を生成してください。

会話履歴:
{conversation}

トピック履歴:
{topics}

感情の変化:
{emotions}

以下のJSON形式で要約を返してください:
{{
  "mainTopics": ["主要なトピック"],
  "emotionalJourney": "感情の変化の説明",
  "keyDecisions": ["重要な決定事項"],
  "actionItems": ["実行すべきアクション"],
  "unresolvedQuestions": ["未解決の質問"]
}}
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    const conversation = state.turns
      .map(t => `${t.role}: ${t.content}`)
      .join('\n');

    const topics = state.topicHistory
      .map(t => `${t.topic} (${new Date(t.startTime).toLocaleTimeString()})`)
      .join(' → ');

    const emotions = state.emotionalArc
      .map(e => e.sentiment)
      .join(' → ');

    try {
      const result = await chain.invoke({
        conversation,
        topics: topics || 'なし',
        emotions: emotions || 'なし',
      });

      return JSON.parse(result);
    } catch (error) {
      console.error('Failed to generate conversation summary:', error);
      return null;
    }
  }

  /**
   * 話題の転換を検出
   */
  @bindThis
  public async detectTopicShift(
    conversationId: string,
    newTopic: string
  ): Promise<{
    shifted: boolean;
    smoothTransition: boolean;
    suggestion?: string;
  }> {
    const state = this.conversations.get(conversationId);
    if (!state || !state.currentTopic) {
      return { shifted: false, smoothTransition: true };
    }

    const prompt = PromptTemplate.fromTemplate(`
現在の話題から新しい話題への転換を分析してください。

現在の話題: {currentTopic}
新しい話題: {newTopic}
最近の会話:
{recentConversation}

以下のJSON形式で分析結果を返してください:
{{
  "shifted": true/false,
  "smoothTransition": true/false,
  "relationScore": 0.0-1.0,
  "suggestion": "スムーズな話題転換のための提案（必要な場合）"
}}
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    const recentConversation = state.turns
      .slice(-5)
      .map(t => `${t.role}: ${t.content}`)
      .join('\n');

    try {
      const result = await chain.invoke({
        currentTopic: state.currentTopic,
        newTopic,
        recentConversation,
      });

      const analysis = JSON.parse(result);
      return {
        shifted: analysis.shifted,
        smoothTransition: analysis.smoothTransition,
        suggestion: analysis.suggestion,
      };
    } catch (error) {
      console.error('Failed to detect topic shift:', error);
      return { shifted: false, smoothTransition: true };
    }
  }

  /**
   * 応答の一貫性をチェック
   */
  @bindThis
  public async checkResponseCoherence(
    conversationId: string,
    proposedResponse: string
  ): Promise<{
    coherent: boolean;
    issues: string[];
    suggestions: string[];
  }> {
    const state = this.conversations.get(conversationId);
    if (!state || state.turns.length === 0) {
      return { coherent: true, issues: [], suggestions: [] };
    }

    const prompt = PromptTemplate.fromTemplate(`
提案された応答が会話の流れと一貫性があるかチェックしてください。

会話の文脈:
{context}

現在の話題: {currentTopic}
未解決の質問: {unresolved}

提案された応答:
{proposedResponse}

以下のJSON形式で分析結果を返してください:
{{
  "coherent": true/false,
  "issues": ["一貫性の問題点"],
  "suggestions": ["改善提案"],
  "addressesUnresolved": ["対処された未解決の質問"]
}}
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    const context = state.turns
      .slice(-5)
      .map(t => `${t.role}: ${t.content}`)
      .join('\n');

    try {
      const result = await chain.invoke({
        context,
        currentTopic: state.currentTopic || 'なし',
        unresolved: state.unresolved.join(', ') || 'なし',
        proposedResponse,
      });

      return JSON.parse(result);
    } catch (error) {
      console.error('Failed to check response coherence:', error);
      return { coherent: true, issues: [], suggestions: [] };
    }
  }

  /**
   * 文脈に基づく応答の強化
   */
  @bindThis
  public async enhanceResponse(
    conversationId: string,
    baseResponse: string
  ): Promise<string> {
    const context = this.getConversationContext(conversationId);
    if (!context) return baseResponse;

    const prompt = PromptTemplate.fromTemplate(`
会話の文脈に基づいて、応答を強化してください。

元の応答: {baseResponse}

現在の話題: {currentTopic}
感情状態: {emotionalState}
重要なポイント: {keyPoints}
未解決の質問: {unresolved}

文脈を考慮して、より適切で自然な応答に改善してください:
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    try {
      const enhancedResponse = await chain.invoke({
        baseResponse,
        currentTopic: context.currentTopic || 'なし',
        emotionalState: context.emotionalState || 'neutral',
        keyPoints: context.keyPoints.join(', ') || 'なし',
        unresolved: context.unresolved.join(', ') || 'なし',
      });

      return enhancedResponse;
    } catch (error) {
      console.error('Failed to enhance response:', error);
      return baseResponse;
    }
  }

  /**
   * 会話の状態を更新
   */
  @bindThis
  private async updateConversationState(
    state: ConversationState,
    turn: ConversationTurn,
    analysis?: AnalysisResult
  ): Promise<void> {
    // トピックの更新
    if (analysis?.topics.main && analysis.topics.main !== state.currentTopic) {
      if (state.currentTopic) {
        // 現在のトピックを履歴に追加
        const currentTopicEntry = state.topicHistory.find(
          t => t.topic === state.currentTopic && !t.endTime
        );
        if (currentTopicEntry) {
          currentTopicEntry.endTime = Date.now();
        }
      }
      
      state.currentTopic = analysis.topics.main;
      state.topicHistory.push({
        topic: analysis.topics.main,
        startTime: Date.now(),
      });
    }

    // 感情の記録
    if (analysis?.sentiment.type) {
      state.emotionalArc.push({
        sentiment: analysis.sentiment.type,
        timestamp: Date.now(),
      });
    }

    // 重要ポイントの抽出
    if (turn.role === 'user' && analysis?.memory.shouldSave) {
      state.keyPoints.push(analysis.memory.summary);
    }

    // 未解決の質問の更新
    if (turn.role === 'user' && analysis?.intent.type === 'question') {
      state.unresolved.push(turn.content);
    } else if (turn.role === 'assistant' && state.unresolved.length > 0) {
      // 応答が質問に答えているかチェック
      await this.checkAnsweredQuestions(state, turn.content);
    }
  }

  /**
   * 回答された質問をチェック
   */
  @bindThis
  private async checkAnsweredQuestions(
    state: ConversationState,
    response: string
  ): Promise<void> {
    if (state.unresolved.length === 0) return;

    const prompt = PromptTemplate.fromTemplate(`
以下の応答が、未解決の質問のどれに答えているか判定してください。

応答: {response}

未解決の質問:
{questions}

答えられた質問の番号をJSON形式で返してください:
{{
  "answered": [回答された質問の番号（0から始まる）]
}}
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    try {
      const result = await chain.invoke({
        response,
        questions: state.unresolved.map((q, i) => `${i}. ${q}`).join('\n'),
      });

      const { answered } = JSON.parse(result);
      
      // 回答された質問を削除
      const answeredQuestions = answered.sort((a: number, b: number) => b - a);
      for (const index of answeredQuestions) {
        state.unresolved.splice(index, 1);
      }
    } catch (error) {
      console.error('Failed to check answered questions:', error);
    }
  }

  /**
   * 古い会話をクリーンアップ
   */
  @bindThis
  private cleanupOldConversations(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24時間

    for (const [id, state] of this.conversations.entries()) {
      const lastTurn = state.turns[state.turns.length - 1];
      if (lastTurn && now - lastTurn.timestamp > maxAge) {
        this.conversations.delete(id);
      }
    }
  }

  /**
   * アクティブな会話を取得
   */
  @bindThis
  public getActiveConversation(userId: string): string | null {
    const now = Date.now();
    const maxInactivity = 30 * 60 * 1000; // 30分

    for (const [id, state] of this.conversations.entries()) {
      if (state.userId !== userId) continue;
      
      const lastTurn = state.turns[state.turns.length - 1];
      if (lastTurn && now - lastTurn.timestamp < maxInactivity) {
        return id;
      }
    }

    return null;
  }
}