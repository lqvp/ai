/**
 * Memory Engine - Orchestrates hybrid memory system
 * Manages the interaction between working memory and long-term memory
 */

import { WorkingMemory } from './WorkingMemory.js';
import { LongTermMemory, EmbeddingService } from './LongTermMemory.js';
import {
  MemoryEntry,
  MemorySearchQuery,
  MemorySearchResult,
  Message,
  ConversationState,
  MemoryType,
  PersonalizationError,
  ConversationIntent,
  EmotionState,
  Entity
} from '../types/index.js';

export class MemoryEngine {
  private workingMemory: WorkingMemory;
  private longTermMemory: LongTermMemory;
  private embeddingService: EmbeddingService;
  private memoryAnalyzer: MemoryAnalyzer;
  
  constructor(
    redisUrl: string,
    chromaUrl: string,
    embeddingService: EmbeddingService,
    memoryAnalyzer: MemoryAnalyzer
  ) {
    this.workingMemory = new WorkingMemory(redisUrl);
    this.longTermMemory = new LongTermMemory(chromaUrl, 'user_memories', embeddingService);
    this.embeddingService = embeddingService;
    this.memoryAnalyzer = memoryAnalyzer;
  }

  /**
   * Initialize the memory engine
   */
  async initialize(): Promise<void> {
    await this.longTermMemory.initialize();
  }

  /**
   * Process a new message and update memories
   */
  async processMessage(
    userId: string,
    message: string,
    role: 'user' | 'assistant',
    sessionId?: string
  ): Promise<{
    session: ConversationState;
    memories: MemoryEntry[];
    analysis: MessageAnalysis;
  }> {
    // Get or create session
    let session: ConversationState;
    if (sessionId) {
      const existingSession = await this.workingMemory.getSession(sessionId);
      if (!existingSession) {
        throw new PersonalizationError(
          'Session not found',
          'PROFILE_NOT_FOUND',
          { sessionId }
        );
      }
      session = existingSession;
    } else {
      session = await this.workingMemory.getOrCreateSession(userId);
    }

    // Analyze the message
    const analysis = await this.memoryAnalyzer.analyzeMessage(message, {
      role,
      context: await this.getConversationContext(session.sessionId)
    });

    // Create message object
    const messageObj: Message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      content: message,
      timestamp: new Date(),
      role,
      metadata: {
        intent: analysis.intent,
        emotion: analysis.emotion,
        entities: analysis.entities,
        responseTime: analysis.responseTime
      }
    };

    // Add to working memory
    await this.workingMemory.addMessage(session.sessionId, messageObj);

    // Update conversation context
    await this.updateConversationContext(session.sessionId, analysis);

    // Determine if this should be saved to long-term memory
    const memories: MemoryEntry[] = [];
    
    if (analysis.shouldSaveToLongTerm) {
      const memoryType = this.determineMemoryType(analysis);
      const importance = this.calculateImportance(analysis);
      
      const memory = await this.longTermMemory.storeMemory(
        userId,
        message,
        memoryType,
        {
          conversationId: session.sessionId,
          importance,
          emotionalValence: analysis.emotion.valence,
          emotionalArousal: analysis.emotion.arousal,
          category: analysis.category,
          summary: analysis.summary
        },
        {
          precedingMessages: await this.getRecentMessages(session.sessionId, 3),
          followingMessages: [],
          topic: session.context.currentTopic.topic,
          intent: analysis.intent,
          mood: {
            userEmotion: analysis.emotion,
            conversationTone: analysis.conversationTone,
            intensity: analysis.emotion.arousal
          }
        }
      );
      
      memories.push(memory);
    }

    return { session, memories, analysis };
  }

  /**
   * Search for relevant memories
   */
  async searchRelevantMemories(
    userId: string,
    query: string,
    sessionId?: string,
    options?: {
      includeWorkingMemory?: boolean;
      limit?: number;
      minImportance?: number;
    }
  ): Promise<MemorySearchResult> {
    const results: MemorySearchResult = {
      entries: [],
      totalCount: 0,
      searchMetadata: {
        executionTime: 0,
        searchStrategy: 'hybrid',
        appliedFilters: []
      }
    };

    const startTime = Date.now();

    // Search long-term memory
    const ltmResults = await this.longTermMemory.searchMemories({
      userId,
      query,
      limit: options?.limit || 10,
      filters: {
        minImportance: options?.minImportance
      }
    });

    results.entries.push(...ltmResults.entries);

    // Include working memory if requested and session exists
    if (options?.includeWorkingMemory && sessionId) {
      const recentMessages = await this.workingMemory.getRecentMessages(sessionId, 20);
      
      // Convert recent messages to memory-like entries for unified processing
      for (const msg of recentMessages) {
        const relevance = await this.calculateRelevance(query, msg.content);
        if (relevance > 0.5) {
          results.entries.push({
            id: `working_${msg.id}`,
            userId,
            type: 'working',
            content: {
              raw: msg.content,
              summary: msg.content.substring(0, 100),
              entities: msg.metadata?.entities || [],
              embedding: [],
              keywords: []
            },
            metadata: {
              timestamp: msg.timestamp,
              conversationId: sessionId,
              importance: 0.7,
              emotionalValence: msg.metadata?.emotion?.valence || 0,
              emotionalArousal: msg.metadata?.emotion?.arousal || 0,
              accessCount: 1,
              lastAccessedAt: new Date(),
              decayFactor: 1.0,
              consolidationState: 'active',
              verificationStatus: 'verified'
            },
            context: {},
            relationships: {
              relatedMemories: [],
              temporalLinks: []
            },
            relevanceScore: relevance,
            matchedFields: ['content'],
            explanation: 'From current conversation'
          });
        }
      }
    }

    // Sort by relevance
    results.entries.sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    // Limit results
    if (options?.limit) {
      results.entries = results.entries.slice(0, options.limit);
    }

    results.totalCount = results.entries.length;
    results.searchMetadata.executionTime = Date.now() - startTime;

    return results;
  }

  /**
   * Get conversation context for prompt construction
   */
  async getConversationContext(sessionId: string): Promise<{
    recentMessages: Message[];
    activeEntities: Entity[];
    currentTopic: string;
    emotionalState: EmotionState;
    unresolvedQuestions: string[];
  }> {
    const session = await this.workingMemory.getSession(sessionId);
    if (!session) {
      throw new PersonalizationError(
        'Session not found',
        'PROFILE_NOT_FOUND',
        { sessionId }
      );
    }

    const recentMessages = await this.workingMemory.getRecentMessages(sessionId, 10);
    const activeEntities = await this.workingMemory.getActiveEntities(sessionId);

    // Get emotional state from recent messages
    const recentEmotions = recentMessages
      .filter(m => m.metadata?.emotion)
      .map(m => m.metadata!.emotion!);
    
    const emotionalState = recentEmotions.length > 0
      ? recentEmotions[recentEmotions.length - 1]
      : { primary: 'neutral' as const, valence: 0, arousal: 0 };

    return {
      recentMessages,
      activeEntities,
      currentTopic: session.context.currentTopic.topic,
      emotionalState,
      unresolvedQuestions: session.context.unresolvedQuestions.map(q => q.question)
    };
  }

  /**
   * Consolidate memories for a user
   */
  async consolidateUserMemories(userId: string): Promise<void> {
    await this.longTermMemory.consolidateMemories(userId);
  }

  /**
   * Apply temporal decay to memories
   */
  async applyTemporalDecay(userId: string): Promise<void> {
    await this.longTermMemory.applyTemporalDecay(userId);
  }

  /**
   * Delete user memories
   */
  async deleteUserMemories(userId: string, options?: {
    includeWorkingMemory?: boolean;
    memoryIds?: string[];
  }): Promise<void> {
    if (options?.memoryIds) {
      // Delete specific memories
      for (const id of options.memoryIds) {
        await this.longTermMemory.deleteMemory(id);
      }
    } else {
      // Delete all long-term memories
      await this.longTermMemory.deleteUserMemories(userId);
    }

    // Clear working memory sessions if requested
    if (options?.includeWorkingMemory) {
      const sessions = await this.workingMemory.getActiveSessions(userId);
      for (const session of sessions) {
        await this.workingMemory.endSession(session.sessionId);
      }
    }
  }

  /**
   * Get memory statistics
   */
  async getMemoryStats(userId: string): Promise<{
    workingMemory: any;
    longTermMemory: {
      totalMemories: number;
      memoryTypes: Record<string, number>;
      averageImportance: number;
      oldestMemory?: Date;
      newestMemory?: Date;
    };
  }> {
    const workingStats = await this.workingMemory.getStats();
    
    // Get long-term memory stats
    const allMemories = await this.longTermMemory.searchMemories({
      userId,
      limit: 10000
    });

    const memoryTypes: Record<string, number> = {};
    let totalImportance = 0;
    let oldestDate: Date | undefined;
    let newestDate: Date | undefined;

    for (const memory of allMemories.entries) {
      memoryTypes[memory.type] = (memoryTypes[memory.type] || 0) + 1;
      totalImportance += memory.metadata.importance;
      
      if (!oldestDate || memory.metadata.timestamp < oldestDate) {
        oldestDate = memory.metadata.timestamp;
      }
      if (!newestDate || memory.metadata.timestamp > newestDate) {
        newestDate = memory.metadata.timestamp;
      }
    }

    return {
      workingMemory: workingStats,
      longTermMemory: {
        totalMemories: allMemories.totalCount,
        memoryTypes,
        averageImportance: allMemories.totalCount > 0 
          ? totalImportance / allMemories.totalCount 
          : 0,
        oldestMemory: oldestDate,
        newestMemory: newestDate
      }
    };
  }

  /**
   * Helper methods
   */
  private async getRecentMessages(sessionId: string, count: number): Promise<string[]> {
    const messages = await this.workingMemory.getRecentMessages(sessionId, count);
    return messages.map(m => `${m.role}: ${m.content}`);
  }

  private async updateConversationContext(
    sessionId: string,
    analysis: MessageAnalysis
  ): Promise<void> {
    const session = await this.workingMemory.getSession(sessionId);
    if (!session) return;

    // Update topic if changed
    if (analysis.topicChange) {
      const oldTopic = session.context.currentTopic;
      session.context.topicHistory.push({
        fromTopic: oldTopic.topic,
        toTopic: analysis.newTopic!,
        timestamp: new Date(),
        transitionType: analysis.topicTransitionType || 'natural'
      });
      
      session.context.currentTopic = {
        topic: analysis.newTopic!,
        startedAt: new Date(),
        depth: 0,
        userEngagement: 0.5
      };
    }

    // Update emotional journey
    if (analysis.emotionChange) {
      const lastEmotion = session.context.emotionalJourney[
        session.context.emotionalJourney.length - 1
      ];
      
      session.context.emotionalJourney.push({
        timestamp: new Date(),
        fromEmotion: lastEmotion?.toEmotion || { 
          primary: 'neutral' as const, 
          valence: 0, 
          arousal: 0 
        },
        toEmotion: analysis.emotion,
        trigger: analysis.emotionTrigger
      });
    }

    // Track unresolved questions
    if (analysis.intent.primary === 'question' && analysis.isUnresolved) {
      session.context.unresolvedQuestions.push({
        question: analysis.content,
        askedAt: new Date(),
        context: session.context.currentTopic.topic,
        attempts: 0,
        importance: analysis.questionImportance || 0.5
      });
    }

    // Update key points
    if (analysis.isKeyPoint) {
      session.context.keyPoints.push({
        content: analysis.keyPointSummary || analysis.content,
        timestamp: new Date(),
        importance: analysis.keyPointImportance || 0.7,
        category: analysis.category || 'general'
      });
    }

    await this.workingMemory.updateContext(sessionId, session.context);
  }

  private determineMemoryType(analysis: MessageAnalysis): MemoryType {
    if (analysis.isFactual) return 'semantic';
    if (analysis.isProcedural) return 'procedural';
    return 'episodic';
  }

  private calculateImportance(analysis: MessageAnalysis): number {
    let importance = 0.5; // Base importance

    // Adjust based on various factors
    if (analysis.isKeyPoint) importance += 0.2;
    if (analysis.emotionalIntensity > 0.7) importance += 0.1;
    if (analysis.hasPersonalInfo) importance += 0.15;
    if (analysis.isUnresolved) importance += 0.1;
    if (analysis.entities.length > 3) importance += 0.05;

    return Math.min(1.0, importance);
  }

  private async calculateRelevance(query: string, content: string): Promise<number> {
    // Simple keyword-based relevance for working memory
    // In production, use embeddings for better accuracy
    const queryWords = query.toLowerCase().split(/\s+/);
    const contentWords = content.toLowerCase().split(/\s+/);
    
    let matches = 0;
    for (const qWord of queryWords) {
      if (contentWords.includes(qWord)) {
        matches++;
      }
    }
    
    return matches / queryWords.length;
  }

  /**
   * Cleanup and disconnect
   */
  async disconnect(): Promise<void> {
    await this.workingMemory.disconnect();
  }
}

/**
 * Interface for memory analyzer
 */
export interface MemoryAnalyzer {
  analyzeMessage(
    message: string,
    context: any
  ): Promise<MessageAnalysis>;
}

/**
 * Message analysis result
 */
export interface MessageAnalysis {
  content: string;
  intent: ConversationIntent;
  emotion: EmotionState;
  entities: Entity[];
  category?: string;
  summary?: string;
  responseTime?: number;
  
  // Memory decision factors
  shouldSaveToLongTerm: boolean;
  isFactual: boolean;
  isProcedural: boolean;
  isKeyPoint: boolean;
  hasPersonalInfo: boolean;
  emotionalIntensity: number;
  
  // Conversation flow
  topicChange: boolean;
  newTopic?: string;
  topicTransitionType?: 'natural' | 'abrupt' | 'user_initiated' | 'ai_initiated';
  emotionChange: boolean;
  emotionTrigger?: string;
  conversationTone: 'positive' | 'neutral' | 'negative' | 'mixed';
  
  // Question tracking
  isUnresolved: boolean;
  questionImportance?: number;
  
  // Key point tracking
  keyPointSummary?: string;
  keyPointImportance?: number;
}