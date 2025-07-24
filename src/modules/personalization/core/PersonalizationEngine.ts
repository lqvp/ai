/**
 * Personalization Engine - Core orchestrator for personalized AI chat experiences
 */

import { MemoryEngine } from '../memory/MemoryEngine.js';
import { ProfileManager } from '../profile/ProfileManager.js';
import { ConversationEngine } from '../conversation/ConversationEngine.js';
import { AnalyticsEngine } from '../analytics/AnalyticsEngine.js';
import {
  UserProfile,
  ConversationState,
  MemoryEntry,
  ResponseContext,
  ResponseConstraints,
  PersonalizationError,
  AnalyticsEvent,
  Message,
  ToneType,
  ToneModifier
} from '../types/index.js';

export class PersonalizationEngine {
  private memoryEngine: MemoryEngine;
  private profileManager: ProfileManager;
  private conversationEngine: ConversationEngine;
  private analyticsEngine: AnalyticsEngine;
  
  constructor(config: PersonalizationConfig) {
    // Initialize all engines
    this.memoryEngine = new MemoryEngine(
      config.redisUrl,
      config.chromaUrl,
      config.embeddingService,
      config.memoryAnalyzer
    );
    
    this.profileManager = new ProfileManager(
      config.postgresUrl,
      config.inferenceEngine
    );
    
    this.conversationEngine = new ConversationEngine(
      config.llmService,
      config.promptTemplates
    );
    
    this.analyticsEngine = new AnalyticsEngine(
      config.elasticsearchUrl
    );
  }

  /**
   * Initialize all components
   */
  async initialize(): Promise<void> {
    await Promise.all([
      this.memoryEngine.initialize(),
      this.profileManager.initialize(),
      this.analyticsEngine.initialize()
    ]);
  }

  /**
   * Process a user message and generate personalized response
   */
  async processMessage(
    userId: string,
    message: string,
    options?: {
      sessionId?: string;
      noteId?: string;
      isChat?: boolean;
      metadata?: Record<string, any>;
    }
  ): Promise<PersonalizedResponse> {
    const startTime = Date.now();
    
    try {
      // 1. Process message through memory engine
      const memoryResult = await this.memoryEngine.processMessage(
        userId,
        message,
        'user',
        options?.sessionId
      );

      // 2. Get user profile
      const profile = await this.profileManager.getOrCreateProfile(userId);

      // 3. Search for relevant memories
      const relevantMemories = await this.memoryEngine.searchRelevantMemories(
        userId,
        message,
        memoryResult.session.sessionId,
        {
          includeWorkingMemory: true,
          limit: 5,
          minImportance: 0.3
        }
      );

      // 4. Build response context
      const responseContext = await this.buildResponseContext(
        profile,
        memoryResult.session,
        relevantMemories.entries,
        message
      );

      // 5. Generate response
      const response = await this.conversationEngine.generateResponse(
        message,
        responseContext
      );

      // 6. Process assistant response through memory
      const assistantMemoryResult = await this.memoryEngine.processMessage(
        userId,
        response.content,
        'assistant',
        memoryResult.session.sessionId
      );

      // 7. Track analytics events
      const events: AnalyticsEvent[] = [
        {
          eventId: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          userId,
          timestamp: new Date(),
          eventType: 'message_received',
          data: {
            message,
            sessionId: memoryResult.session.sessionId,
            analysis: memoryResult.analysis
          }
        },
        {
          eventId: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          userId,
          timestamp: new Date(),
          eventType: 'message_sent',
          data: {
            response: response.content,
            sessionId: memoryResult.session.sessionId,
            responseTime: Date.now() - startTime,
            memoryAccessed: relevantMemories.entries.length
          }
        }
      ];

      await this.analyticsEngine.trackEvents(events);

      // 8. Update profile based on conversation
      const profileUpdate = await this.profileManager.learnFromConversation(
        userId,
        events
      );

      // 9. Handle special commands
      const commandResult = await this.handleSpecialCommands(
        message,
        userId,
        memoryResult.session.sessionId
      );

      if (commandResult) {
        return {
          content: commandResult.response,
          sessionId: memoryResult.session.sessionId,
          metadata: {
            commandType: commandResult.type,
            processingTime: Date.now() - startTime
          }
        };
      }

      return {
        content: response.content,
        sessionId: memoryResult.session.sessionId,
        metadata: {
          processingTime: Date.now() - startTime,
          memoriesAccessed: relevantMemories.entries.length,
          relationshipLevel: profile.metadata.relationshipLevel,
          responseStyle: response.style,
          confidence: response.confidence
        }
      };

    } catch (error) {
      // Track error
      await this.analyticsEngine.trackEvents([{
        eventId: `evt_${Date.now()}_error`,
        userId,
        timestamp: new Date(),
        eventType: 'error',
        data: {
          error: error instanceof Error ? error.message : 'Unknown error',
          context: 'processMessage'
        }
      }]);

      throw error;
    }
  }

  /**
   * Build response context from profile, memories, and current state
   */
  private async buildResponseContext(
    profile: UserProfile,
    conversationState: ConversationState,
    relevantMemories: MemoryEntry[],
    currentMessage: string
  ): Promise<ResponseContext> {
    // Determine response constraints based on profile
    const constraints = this.determineResponseConstraints(profile, conversationState);
    
    // Build system prompt incorporating personality
    const systemPrompt = this.buildSystemPrompt(profile, conversationState);

    // Get conversation context
    const conversationContext = await this.memoryEngine.getConversationContext(
      conversationState.sessionId
    );

    return {
      userProfile: profile,
      conversationState,
      relevantMemories,
      systemPrompt,
      constraints
    };
  }

  /**
   * Determine response constraints based on user profile
   */
  private determineResponseConstraints(
    profile: UserProfile,
    state: ConversationState
  ): ResponseConstraints {
    const prefs = profile.preferences.communication;
    
    // Determine tone based on relationship and preferences
    let primaryTone: ToneType = 'friendly';
    const modifiers: ToneModifier[] = [];

    if (profile.metadata.relationshipLevel === 'new') {
      primaryTone = 'professional';
      modifiers.push('gentle');
    } else if (profile.metadata.relationshipLevel === 'collaborator') {
      primaryTone = prefs.formality > 0.7 ? 'professional' : 'casual';
      if (prefs.humor > 0.6) modifiers.push('playful');
    }

    // Add emotional modifiers based on current state
    const currentEmotion = state.context.emotionalJourney[
      state.context.emotionalJourney.length - 1
    ]?.toEmotion;
    
    if (currentEmotion?.valence < -0.3) {
      modifiers.push('supportive');
      primaryTone = 'empathetic';
    }

    return {
      maxLength: prefs.responseLength === 'brief' ? 150 : 
                 prefs.responseLength === 'detailed' ? 500 : 300,
      tone: {
        primary: primaryTone,
        modifiers
      },
      mustAvoid: profile.preferences.topics.avoidTopics,
      creativity: prefs.creativity,
      formality: prefs.formality
    };
  }

  /**
   * Build system prompt incorporating user personality and preferences
   */
  private buildSystemPrompt(
    profile: UserProfile,
    state: ConversationState
  ): string {
    const parts: string[] = [];

    // Base personality
    parts.push("You are a personalized AI assistant with deep understanding of the user.");

    // Relationship context
    const relationshipContext = {
      new: "This is a new user. Be welcoming, professional, and help them feel comfortable.",
      familiar: "You've chatted before. Be friendly while maintaining appropriate boundaries.",
      friend: "You have an established friendship. Be warm, supportive, and engaging.",
      collaborator: "You're trusted partners. Be direct, insightful, and proactive."
    };
    parts.push(relationshipContext[profile.metadata.relationshipLevel]);

    // Communication style
    if (profile.preferences.communication.formality > 0.7) {
      parts.push("Use formal, respectful language.");
    } else if (profile.preferences.communication.formality < 0.3) {
      parts.push("Use casual, conversational language.");
    }

    // Personality adaptation
    const traits = profile.personality.traits;
    if (traits.openness > 0.7) {
      parts.push("The user appreciates creative and novel ideas.");
    }
    if (traits.conscientiousness > 0.7) {
      parts.push("The user values detailed, well-organized responses.");
    }
    if (traits.extraversion > 0.7) {
      parts.push("The user enjoys energetic, enthusiastic conversations.");
    }

    // Current context
    parts.push(`Current topic: ${state.context.currentTopic.topic}`);
    
    // User-specific knowledge
    if (profile.identity.confirmedInfo.name) {
      parts.push(`The user's name is ${profile.identity.confirmedInfo.name}.`);
    }

    // Interests
    const topInterests = profile.preferences.topics.interests
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    
    if (topInterests.length > 0) {
      parts.push(`The user is interested in: ${topInterests.map(i => i.topic).join(', ')}.`);
    }

    return parts.join(' ');
  }

  /**
   * Handle special user commands
   */
  private async handleSpecialCommands(
    message: string,
    userId: string,
    sessionId: string
  ): Promise<CommandResult | null> {
    const lowerMessage = message.toLowerCase();

    // Memory display commands
    if (lowerMessage.includes('記憶を見せて') || lowerMessage.includes('メモリーを見せて')) {
      const memories = await this.memoryEngine.searchRelevantMemories(
        userId,
        '',
        sessionId,
        { limit: 10 }
      );
      
      const memoryList = memories.entries
        .map((m, i) => `${i + 1}. ${m.content.summary || m.content.raw.substring(0, 50)}...`)
        .join('\n');
      
      return {
        type: 'show_memories',
        response: `最近の記憶:\n${memoryList}\n\n記憶数: ${memories.totalCount}件`
      };
    }

    // Profile display commands
    if (lowerMessage.includes('プロファイルを見せて') || 
        lowerMessage.includes('私のことどう思ってる')) {
      const summary = await this.profileManager.getProfileSummary(userId);
      return {
        type: 'show_profile',
        response: summary
      };
    }

    // Memory reset commands
    if (lowerMessage.includes('記憶をリセット') || lowerMessage.includes('メモリーをリセット')) {
      return {
        type: 'confirm_reset',
        response: '本当に全ての記憶とプロファイルをリセットしますか？「はい、リセットして」と返信してください。'
      };
    }

    if (lowerMessage === 'はい、リセットして') {
      await this.memoryEngine.deleteUserMemories(userId, { includeWorkingMemory: true });
      await this.profileManager.deleteProfile(userId);
      
      return {
        type: 'reset_complete',
        response: '全ての記憶とプロファイルをリセットしました。また新しく関係を築いていきましょう。'
      };
    }

    // Memory search commands
    const searchMatch = message.match(/記憶を検索[：:]\s*(.+)/);
    if (searchMatch) {
      const query = searchMatch[1];
      const results = await this.memoryEngine.searchRelevantMemories(
        userId,
        query,
        sessionId,
        { limit: 5 }
      );
      
      const resultList = results.entries
        .map((m, i) => `${i + 1}. [${(m.relevanceScore * 100).toFixed(0)}%] ${m.content.summary || m.content.raw.substring(0, 50)}...`)
        .join('\n');
      
      return {
        type: 'search_memories',
        response: `「${query}」の検索結果:\n${resultList}`
      };
    }

    // Memory statistics
    if (lowerMessage.includes('記憶の統計') || lowerMessage.includes('メモリー統計')) {
      const stats = await this.memoryEngine.getMemoryStats(userId);
      const profile = await this.profileManager.getOrCreateProfile(userId);
      
      const avgSentiment = profile.statistics.sentimentTrend.length > 0
        ? profile.statistics.sentimentTrend.reduce((sum, s) => sum + s.sentiment, 0) / 
          profile.statistics.sentimentTrend.length
        : 0;
      
      return {
        type: 'show_stats',
        response: `記憶統計:
- 総記憶数: ${stats.longTermMemory.totalMemories}
- 記憶タイプ: ${Object.entries(stats.longTermMemory.memoryTypes)
  .map(([type, count]) => `${type}: ${count}`)
  .join(', ')}
- 平均重要度: ${(stats.longTermMemory.averageImportance * 100).toFixed(0)}%
- 感情傾向: ${avgSentiment > 0.2 ? 'ポジティブ' : avgSentiment < -0.2 ? 'ネガティブ' : 'ニュートラル'}
- アクティブセッション: ${stats.workingMemory.activeSessions}`
      };
    }

    return null;
  }

  /**
   * Get user insights and recommendations
   */
  async getUserInsights(userId: string): Promise<UserInsights> {
    return this.analyticsEngine.generateUserInsights(userId);
  }

  /**
   * Periodic maintenance tasks
   */
  async runMaintenance(): Promise<void> {
    // This would be called by a cron job
    const users = await this.getAllActiveUsers();
    
    for (const userId of users) {
      // Apply temporal decay
      await this.memoryEngine.applyTemporalDecay(userId);
      
      // Consolidate memories if needed
      await this.memoryEngine.consolidateUserMemories(userId);
      
      // Generate insights
      await this.analyticsEngine.generateUserInsights(userId);
    }
    
    // Clean up old sessions
    await this.memoryEngine.cleanupExpiredSessions();
  }

  /**
   * Get all active users (placeholder)
   */
  private async getAllActiveUsers(): Promise<string[]> {
    // In production, this would query the database
    return [];
  }

  /**
   * Cleanup and disconnect
   */
  async disconnect(): Promise<void> {
    await Promise.all([
      this.memoryEngine.disconnect(),
      this.profileManager.disconnect(),
      this.analyticsEngine.disconnect()
    ]);
  }
}

/**
 * Interfaces
 */
export interface PersonalizationConfig {
  redisUrl: string;
  chromaUrl: string;
  postgresUrl: string;
  elasticsearchUrl: string;
  embeddingService: any;
  memoryAnalyzer: any;
  inferenceEngine: any;
  llmService: any;
  promptTemplates: any;
}

export interface PersonalizedResponse {
  content: string;
  sessionId: string;
  metadata: {
    processingTime: number;
    memoriesAccessed?: number;
    relationshipLevel?: string;
    responseStyle?: any;
    confidence?: number;
    commandType?: string;
  };
}

export interface CommandResult {
  type: string;
  response: string;
}

export interface UserInsights {
  userId: string;
  generatedAt: Date;
  insights: any[];
  recommendations: any[];
}