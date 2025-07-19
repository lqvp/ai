import { bindThis } from '@/decorators.js';
import type 藍 from '@/ai.js';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { Chroma } from '@langchain/community/vectorstores/chroma';
import { Document } from '@langchain/core/documents';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';
import { PromptTemplate } from '@langchain/core/prompts';
import config from '@/config.js';
import LLMAnalyzer, { AnalysisResult } from './LLMAnalyzer.js';

export interface VectorMemory {
  id: string;
  userId: string;
  content: string;
  summary: string;
  category: string;
  importance: number;
  timestamp: number;
  metadata: Record<string, any>;
}

export interface ConversationContext {
  recentMessages: Array<{ role: string; content: string; timestamp: number }>;
  currentTopic?: string;
  sentiment?: string;
  userMood?: string;
}

/**
 * ベクトル検索を使用した高度なメモリマネージャー
 */
export default class VectorMemoryManager {
  private ai: 藍;
  private analyzer: LLMAnalyzer;
  private embeddings: GoogleGenerativeAIEmbeddings;
  private vectorStore: Chroma | null = null;
  private llm: ChatGoogleGenerativeAI;
  private collectionName: string = 'ai_memories';

  constructor(ai: 藍) {
    this.ai = ai;
    this.analyzer = new LLMAnalyzer();
    
    const apiKey = config.gemini?.apiKey || '';
    if (!apiKey) {
      console.warn('Gemini API key is not configured. VectorMemoryManager features will be disabled.');
    }
    
    // LangChain設定
    this.embeddings = new GoogleGenerativeAIEmbeddings({
      model: 'gemini-embedding-001',
      apiKey: apiKey,
    });

    this.llm = new ChatGoogleGenerativeAI({
      model: config.gemini?.model || 'gemini-2.5-flash',
      apiKey: apiKey,
      temperature: 0.3,
    });

    this.initializeVectorStore();
  }

  /**
   * ベクトルストアの初期化
   */
  @bindThis
  private async initializeVectorStore(): Promise<void> {
    try {
      this.vectorStore = new Chroma(this.embeddings, {
        collectionName: this.collectionName,
        url: 'http://localhost:8000', // ChromaDBのデフォルトURL
      });
    } catch (error) {
      console.error('Failed to initialize vector store:', error);
      // フォールバック: インメモリベクトルストアを使用
      this.vectorStore = await Chroma.fromDocuments(
        [],
        this.embeddings,
        { collectionName: this.collectionName }
      );
    }
  }

  /**
   * 会話分析結果から記憶を保存
   */
  @bindThis
  public async saveFromAnalysis(
    userId: string,
    message: string,
    analysis: AnalysisResult,
    context?: ConversationContext
  ): Promise<VectorMemory | null> {
    if (!analysis.memory.shouldSave || !this.vectorStore) {
      return null;
    }

    const memoryId = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // コンテキストを含めた拡張サマリーを生成
    const extendedSummary = await this.generateExtendedSummary(
      message,
      analysis,
      context
    );

    const memory: VectorMemory = {
      id: memoryId,
      userId,
      content: message,
      summary: extendedSummary || analysis.memory.summary,
      category: analysis.memory.category,
      importance: analysis.memory.importance,
      timestamp: Date.now(),
      metadata: {
        sentiment: analysis.sentiment.type,
        emotions: analysis.sentiment.emotions,
        topics: analysis.topics.keywords,
        entities: analysis.topics.entities,
        intent: analysis.intent.type,
        contextualInfo: context?.currentTopic || '',
      }
    };

    // ベクトルストアに保存
    const document = new Document({
      pageContent: `${memory.summary}\n\n元のメッセージ: ${memory.content}`,
      metadata: {
        ...memory.metadata,
        id: memory.id,
        userId: memory.userId,
        timestamp: memory.timestamp,
        importance: memory.importance,
        category: memory.category,
      }
    });

    await this.vectorStore.addDocuments([document]);

    return memory;
  }

  /**
   * セマンティック検索で関連する記憶を取得
   */
  @bindThis
  public async getSemanticMemories(
    userId: string,
    query: string,
    limit: number = 5,
    context?: ConversationContext
  ): Promise<VectorMemory[]> {
    if (!this.vectorStore) {
      return [];
    }

    // コンテキストを考慮したクエリ拡張
    const expandedQuery = await this.expandQuery(query, context);

    // セマンティック検索
    const results = await this.vectorStore.similaritySearchWithScore(
      expandedQuery,
      limit * 2, // 多めに取得してフィルタリング
      {
        userId: userId,
      }
    );

    // スコアとコンテキストでフィルタリング・ランキング
    const memories = await this.rankMemories(
      results.map(([doc, score]) => ({
        memory: this.documentToMemory(doc),
        score,
      })),
      query,
      context
    );

    return memories.slice(0, limit);
  }

  /**
   * 会話の要約を生成
   */
  @bindThis
  public async generateConversationSummary(
    messages: Array<{ role: string; content: string; timestamp: number }>
  ): Promise<string> {
    const prompt = PromptTemplate.fromTemplate(`
以下の会話履歴を簡潔に要約してください。重要なポイント、決定事項、感情的な変化を含めてください。

会話履歴:
{conversation}

要約:
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    const conversation = messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    try {
      const summary = await chain.invoke({ conversation });
      return summary;
    } catch (error) {
      console.error('Failed to generate conversation summary:', error);
      return '';
    }
  }

  /**
   * 記憶の統合と整理
   */
  @bindThis
  public async consolidateMemories(userId: string): Promise<void> {
    if (!this.vectorStore) {
      return;
    }

    // 古い記憶を取得
    const oldMemories = await this.vectorStore.similaritySearch(
      '',
      100,
      {
        userId,
        timestamp: { $lt: Date.now() - 30 * 24 * 60 * 60 * 1000 }, // 30日以上前
      }
    );

    if (oldMemories.length < 20) {
      return;
    }

    // カテゴリごとにグループ化
    const categorizedMemories = this.groupByCategory(oldMemories);

    // 各カテゴリの記憶を要約
    for (const [category, memories] of Object.entries(categorizedMemories)) {
      if (memories.length < 5) continue;

      const summary = await this.summarizeMemoryGroup(memories);
      
      // 要約を新しい記憶として保存
      const consolidatedMemory = new Document({
        pageContent: summary,
        metadata: {
          id: `consolidated_${Date.now()}_${category}`,
          userId,
          timestamp: Date.now(),
          importance: 0.7,
          category: `${category}_summary`,
          type: 'consolidated',
          originalCount: memories.length,
        }
      });

      await this.vectorStore.addDocuments([consolidatedMemory]);

      // 元の記憶を削除（実装は省略）
      // await this.deleteMemories(memories.map(m => m.metadata.id));
    }
  }

  /**
   * パーソナライゼーション用のユーザープロファイル生成
   */
  @bindThis
  public async generateUserProfile(userId: string): Promise<Record<string, any>> {
    if (!this.vectorStore) {
      return {};
    }

    // 最近の記憶を取得
    const recentMemories = await this.vectorStore.similaritySearch(
      '',
      50,
      {
        userId,
        timestamp: { $gt: Date.now() - 7 * 24 * 60 * 60 * 1000 }, // 過去7日間
      }
    );

    if (recentMemories.length === 0) {
      return {};
    }

    const prompt = PromptTemplate.fromTemplate(`
以下のユーザーの記憶から、ユーザーのプロファイルを生成してください。

記憶:
{memories}

以下のJSON形式で返答してください:
{{
  "interests": ["興味のあるトピック"],
  "communicationStyle": {{
    "formality": "formal/casual/mixed",
    "preferredLength": "short/medium/long",
    "emotiveness": "high/medium/low"
  }},
  "personality": {{
    "traits": ["性格特性"],
    "mood": "一般的な気分"
  }},
  "preferences": {{
    "topics": ["好きな話題"],
    "avoidTopics": ["避けたい話題"],
    "responseStyle": "詳細な説明を好む/簡潔を好む/など"
  }},
  "insights": ["ユーザーに関する洞察"]
}}
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    const memorySummaries = recentMemories
      .map(doc => doc.pageContent)
      .join('\n---\n');

    try {
      const profileJson = await chain.invoke({ memories: memorySummaries });
      return JSON.parse(profileJson);
    } catch (error) {
      console.error('Failed to generate user profile:', error);
      return {};
    }
  }

  /**
   * クエリ拡張
   */
  @bindThis
  private async expandQuery(
    query: string,
    context?: ConversationContext
  ): Promise<string> {
    if (!context || !context.recentMessages || context.recentMessages.length === 0) {
      return query;
    }

    const prompt = PromptTemplate.fromTemplate(`
以下のクエリを、文脈を考慮して拡張してください。関連するキーワードや概念を追加してください。

元のクエリ: {query}
現在の話題: {topic}
最近の会話: {recentMessages}

拡張されたクエリ:
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    try {
      const expandedQuery = await chain.invoke({
        query,
        topic: context.currentTopic || 'なし',
        recentMessages: context.recentMessages
          .slice(-3)
          .map(m => `${m.role}: ${m.content}`)
          .join('\n'),
      });
      return expandedQuery;
    } catch (error) {
      console.error('Failed to expand query:', error);
      return query;
    }
  }

  /**
   * 記憶のランキング
   */
  @bindThis
  private async rankMemories(
    results: Array<{ memory: VectorMemory; score: number }>,
    query: string,
    context?: ConversationContext
  ): Promise<VectorMemory[]> {
    // コンテキストとの関連性でスコアを調整
    const rankedResults = results.map(result => {
      let adjustedScore = result.score;

      // 重要度による調整
      adjustedScore *= (1 + result.memory.importance * 0.5);

      // 時間による減衰（新しいものを優先）
      const ageInDays = (Date.now() - result.memory.timestamp) / (24 * 60 * 60 * 1000);
      adjustedScore *= Math.exp(-ageInDays / 30); // 30日で約37%に減衰

      // コンテキストとの一致
      if (context?.currentTopic && result.memory.metadata.contextualInfo === context.currentTopic) {
        adjustedScore *= 1.5;
      }

      return { ...result, adjustedScore };
    });

    // スコアでソート
    rankedResults.sort((a, b) => b.adjustedScore - a.adjustedScore);

    return rankedResults.map(r => r.memory);
  }

  /**
   * 拡張サマリーの生成
   */
  @bindThis
  private async generateExtendedSummary(
    message: string,
    analysis: AnalysisResult,
    context?: ConversationContext
  ): Promise<string | null> {
    const prompt = PromptTemplate.fromTemplate(`
以下の情報から、記憶として保存すべき内容の拡張サマリーを生成してください。

メッセージ: {message}
基本サマリー: {summary}
感情: {sentiment}
トピック: {topics}
文脈: {context}

拡張サマリー（1-2文で簡潔に）:
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    try {
      const extendedSummary = await chain.invoke({
        message,
        summary: analysis.memory.summary,
        sentiment: analysis.sentiment.type,
        topics: analysis.topics.keywords.join(', '),
        context: context?.currentTopic || 'なし',
      });
      return extendedSummary;
    } catch (error) {
      console.error('Failed to generate extended summary:', error);
      return null;
    }
  }

  /**
   * ドキュメントをメモリに変換
   */
  @bindThis
  private documentToMemory(doc: Document): VectorMemory {
    return {
      id: doc.metadata.id as string,
      userId: doc.metadata.userId as string,
      content: doc.metadata.content || doc.pageContent,
      summary: doc.pageContent,
      category: doc.metadata.category as string,
      importance: doc.metadata.importance as number,
      timestamp: doc.metadata.timestamp as number,
      metadata: doc.metadata,
    };
  }

  /**
   * カテゴリごとにグループ化
   */
  @bindThis
  private groupByCategory(documents: Document[]): Record<string, Document[]> {
    const groups: Record<string, Document[]> = {};
    
    for (const doc of documents) {
      const category = doc.metadata.category as string || 'general';
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(doc);
    }

    return groups;
  }

  /**
   * 記憶グループの要約
   */
  @bindThis
  private async summarizeMemoryGroup(memories: Document[]): Promise<string> {
    const prompt = PromptTemplate.fromTemplate(`
以下の記憶リストを要約してください。共通のテーマ、パターン、重要な情報を含めてください。

記憶:
{memories}

要約:
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    const memoryContents = memories
      .map(m => m.pageContent)
      .join('\n---\n');

    try {
      const summary = await chain.invoke({ memories: memoryContents });
      return summary;
    } catch (error) {
      console.error('Failed to summarize memory group:', error);
      return '記憶グループの要約に失敗しました。';
    }
  }
}