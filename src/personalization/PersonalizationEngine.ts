import { bindThis } from '@/decorators.js';
import loki from 'lokijs';
import {
  ResponseContext,
  PersonalizedPrompt,
  MemoryType,
  MemorySource,
  WorkingMemoryItem
} from './types.js';
import UserProfileManager from './UserProfileManager.js';
import HybridMemorySystem from './HybridMemorySystem.js';
import ContextEngine from './ContextEngine.js';
import UserMemoryInterface from './UserMemoryInterface.js';

/**
 * パーソナライゼーションエンジン
 * すべてのパーソナライゼーション機能の中央オーケストレーター
 */
export default class PersonalizationEngine {
  private profileManager: UserProfileManager;
  private memorySystem: HybridMemorySystem;
  private contextEngine: ContextEngine;
  private userInterface: UserMemoryInterface;
  
  // バックグラウンドタスクの間隔
  private forgettingInterval: NodeJS.Timeout | null = null;
  private consolidationInterval: NodeJS.Timeout | null = null;
  
  // 設定
  private readonly FORGETTING_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24時間
  private readonly CONSOLIDATION_CHECK_MS = 30 * 60 * 1000; // 30分

  constructor(private db: loki) {
    // コンポーネントを初期化
    this.profileManager = new UserProfileManager(db);
    this.memorySystem = new HybridMemorySystem(db);
    this.contextEngine = new ContextEngine(this.memorySystem, this.profileManager);
    this.userInterface = new UserMemoryInterface(this.memorySystem, this.profileManager);
    
    // バックグラウンドタスクを開始
    this.startBackgroundTasks();
  }

  /**
   * パーソナライゼーションを使用して受信メッセージを処理
   */
  @bindThis
  public async processMessage(
    userId: string,
    message: string,
    sessionId?: string
  ): Promise<{
    response?: string;
    personalizedPrompt?: PersonalizedPrompt;
    commandResult?: { success: boolean; message: string; data?: any };
  }> {
    // メッセージがコマンドかどうかをチェック
    const commandResult = await this.userInterface.processCommand(userId, message);
    if (commandResult.success || message.match(/^(help|ヘルプ|h|\?|memories?|記憶|思い出|forget|忘れる|忘却|update_info|情報更新|update|profile|プロフィール|prof|export_data|データエクスポート|export|delete_all_data|全データ削除|delete_all)/i)) {
      return { commandResult };
    }
    
    // Create or get session
    const activeSessionId = sessionId || await this.createSession(userId);
    
    // Build response context
    const context = await this.contextEngine.buildResponseContext(
      userId,
      message,
      activeSessionId
    );
    
    // Generate personalized prompt
    const personalizedPrompt = await this.contextEngine.generatePersonalizedPrompt(context);
    
    // Record interaction
    await this.profileManager.recordInteraction(userId);
    
    // Infer implicit information from message
    await this.profileManager.inferImplicitInfo(userId, {
      message,
      entities: context.shortTermContext.context.entities.map(e => e.text)
    });
    
    return { personalizedPrompt };
  }

  /**
   * Store AI response and extract information
   */
  @bindThis
  public async processResponse(
    userId: string,
    sessionId: string,
    userMessage: string,
    aiResponse: string
  ): Promise<void> {
    // Process response for information extraction
    await this.contextEngine.processResponse(
      userId,
      sessionId,
      aiResponse,
      userMessage
    );
    
    // Check for important information to store
    await this.extractAndStoreImportantInfo(userId, userMessage, aiResponse);
  }

  /**
   * Create a new session
   */
  @bindThis
  public async createSession(userId: string): Promise<string> {
    const session = await this.memorySystem.getOrCreateSession(userId);
    return session.sessionId;
  }

  /**
   * Get personalization statistics
   */
  @bindThis
  public async getStats(userId: string): Promise<{
    profile: any;
    memoryStats: any;
    sessionCount: number;
  }> {
    const profile = await this.profileManager.getOrCreateProfile(userId);
    const memoryStats = await this.memorySystem.getMemoryStats(userId);
    
    // Count active sessions (simplified)
    const sessionCount = 1; // In production, track active sessions properly
    
    return {
      profile: {
        relationshipLevel: profile.relationship.level,
        totalInteractions: profile.relationship.totalInteractions,
        dataQuality: profile.meta.dataQuality,
        trustScore: profile.relationship.trustScore
      },
      memoryStats,
      sessionCount
    };
  }

  /**
   * Shutdown and cleanup
   */
  @bindThis
  public shutdown(): void {
    // Stop background tasks
    if (this.forgettingInterval) {
      clearInterval(this.forgettingInterval);
      this.forgettingInterval = null;
    }
    
    if (this.consolidationInterval) {
      clearInterval(this.consolidationInterval);
      this.consolidationInterval = null;
    }
  }

  // Private methods

  private startBackgroundTasks(): void {
    // Forgetting mechanism - runs daily
    this.forgettingInterval = setInterval(async () => {
      await this.runForgettingMechanism();
    }, this.FORGETTING_INTERVAL_MS);
    
    // Memory consolidation check - runs every 30 minutes
    this.consolidationInterval = setInterval(async () => {
      await this.checkMemoryConsolidation();
    }, this.CONSOLIDATION_CHECK_MS);
  }

  private async runForgettingMechanism(): Promise<void> {
    try {
      // Get all users (in production, this would be more efficient)
      const profiles = this.db.getCollection('userProfiles').find({});
      
      for (const profile of profiles) {
        // Apply forgetting to memories
        await this.memorySystem.applyForgetting(profile.userId);
        
        // Apply forgetting to profile
        await this.profileManager.applyForgetting(profile.userId);
      }
    } catch (error) {
      console.error('Error in forgetting mechanism:', error);
    }
  }

  private async checkMemoryConsolidation(): Promise<void> {
    try {
      // Get active sessions
      const sessions = this.db.getCollection('shortTermMemories').find({});
      
      for (const session of sessions) {
        // Check if session should be consolidated
        const shouldConsolidate = 
          session.workingMemory.length >= 10 ||
          Date.now() - session.lastUpdate > 20 * 60 * 1000; // 20 minutes idle
        
        if (shouldConsolidate) {
          await this.memorySystem.consolidateMemories(
            session.sessionId,
            session.userId
          );
        }
      }
    } catch (error) {
      console.error('Error in memory consolidation:', error);
    }
  }

  private async extractAndStoreImportantInfo(
    userId: string,
    userMessage: string,
    aiResponse: string
  ): Promise<void> {
    // Extract facts from conversation
    const facts = this.extractFacts(userMessage);
    
    for (const fact of facts) {
      await this.memorySystem.storeMemory(
        userId,
        fact.content,
        MemoryType.SEMANTIC,
        {
          entities: fact.entities,
          source: MemorySource.DIRECT_STATEMENT,
          confidence: fact.confidence,
          tags: fact.tags
        },
        fact.importance
      );
    }
    
    // Store important episodic moments
    if (this.isImportantMoment(userMessage, aiResponse)) {
      const episodicContent = `User: ${userMessage}\nAI: ${aiResponse.substring(0, 200)}...`;
      
      await this.memorySystem.storeMemory(
        userId,
        episodicContent,
        MemoryType.EPISODIC,
        {
          entities: [],
          source: MemorySource.OBSERVED,
          confidence: 0.8,
          tags: ['conversation', 'important']
        },
        0.7
      );
    }
  }

  private extractFacts(message: string): Array<{
    content: string;
    entities: string[];
    confidence: number;
    tags: string[];
    importance: number;
  }> {
    const facts: Array<{
      content: string;
      entities: string[];
      confidence: number;
      tags: string[];
      importance: number;
    }> = [];
    
    // Patterns for extracting facts
    const patterns = [
      {
        regex: /(?:I am|I'm) ([^.!?]+)/i,
        tag: 'identity',
        importance: 0.8
      },
      {
        regex: /(?:I work|My job|I do) ([^.!?]+)/i,
        tag: 'occupation',
        importance: 0.7
      },
      {
        regex: /(?:I like|I love|I enjoy) ([^.!?]+)/i,
        tag: 'preference',
        importance: 0.6
      },
      {
        regex: /(?:I have|I own) ([^.!?]+)/i,
        tag: 'possession',
        importance: 0.5
      },
      {
        regex: /(?:My goal|I want to|I plan to) ([^.!?]+)/i,
        tag: 'goal',
        importance: 0.8
      }
    ];
    
    for (const pattern of patterns) {
      const match = message.match(pattern.regex);
      if (match && match[0] && match[1]) {
        facts.push({
          content: match[0],
          entities: this.extractEntities(match[1]),
          confidence: 0.9,
          tags: [pattern.tag, 'user_fact'],
          importance: pattern.importance
        });
      }
    }
    
    return facts;
  }

  private extractEntities(text: string): string[] {
    // Simple entity extraction
    const entities: string[] = [];
    
    // Extract capitalized words as potential entities
    const capitalizedWords = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
    entities.push(...capitalizedWords);
    
    return [...new Set(entities)];
  }

  private isImportantMoment(userMessage: string, aiResponse: string): boolean {
    // Heuristics for determining important moments
    const importantIndicators = [
      /thank you|thanks/i,
      /that helps|very helpful/i,
      /amazing|wonderful|excellent/i,
      /problem solved|fixed it/i,
      /learned something/i,
      /milestone|achievement/i,
      /important|significant/i
    ];
    
    const combinedText = userMessage + ' ' + aiResponse;
    
    return importantIndicators.some(pattern => pattern.test(combinedText));
  }

  /**
   * Build prompt with personalization context
   */
  @bindThis
  public buildPromptWithContext(
    personalizedPrompt: PersonalizedPrompt,
    userMessage: string
  ): string {
    const parts: string[] = [];
    
    // System context
    parts.push(`[System Context]`);
    parts.push(personalizedPrompt.systemPrompt);
    parts.push('');
    
    // Relationship context
    parts.push(`[Relationship Context]`);
    parts.push(personalizedPrompt.relationshipContext);
    parts.push('');
    
    // Style guidance
    parts.push(`[Communication Style]`);
    parts.push(personalizedPrompt.styleGuidance);
    parts.push('');
    
    // User context
    if (personalizedPrompt.userContext) {
      parts.push(`[User Context]`);
      parts.push(personalizedPrompt.userContext);
      parts.push('');
    }
    
    // Relevant memories
    if (personalizedPrompt.relevantMemories.length > 0) {
      parts.push(`[Relevant Past Information]`);
      personalizedPrompt.relevantMemories.forEach((memory, index) => {
        parts.push(`${index + 1}. ${memory.content}`);
      });
      parts.push('');
    }
    
    // Current message
    parts.push(`[Current User Message]`);
    parts.push(userMessage);
    
    return parts.join('\n');
  }
}