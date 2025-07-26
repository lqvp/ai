import { bindThis } from '@/decorators.js';
import loki from 'lokijs';
import { v4 as uuid } from 'uuid';
import {
  Memory,
  MemoryType,
  MemoryMetadata,
  MemorySource,
  ShortTermMemory,
  ConversationContext,
  WorkingMemoryItem,
  Entity,
  VectorMemory,
  MemoryQuery,
  PersonalizationError,
  PersonalizationErrorCode
} from './types.js';

/**
 * ハイブリッド記憶システム
 * インテリジェントな検索と忘却機能を備えた短期および長期記憶を管理
 */
export default class HybridMemorySystem {
  private memories: loki.Collection<Memory>;
  private shortTermMemories: loki.Collection<ShortTermMemory>;
  private vectorMemories: loki.Collection<VectorMemory>;
  
  // 記憶設定
  private readonly MAX_WORKING_MEMORY_SIZE = 10;
  private readonly MAX_SHORT_TERM_SESSIONS = 100;
  private readonly MEMORY_DECAY_RATE = 0.95; // 月あたり
  private readonly IMPORTANCE_THRESHOLD = 0.3;
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30分

  constructor(private db: loki) {
    this.memories = this.db.getCollection('memories') || 
      this.db.addCollection('memories', {
        indices: ['userId', 'type', 'timestamp', 'importance']
      });
    
    this.shortTermMemories = this.db.getCollection('shortTermMemories') || 
      this.db.addCollection('shortTermMemories', {
        indices: ['userId', 'sessionId', 'lastUpdate']
      });
    
    this.vectorMemories = this.db.getCollection('vectorMemories') || 
      this.db.addCollection('vectorMemories', {
        indices: ['userId', 'timestamp']
      });
  }

  /**
   * 新しい記憶を保存
   */
  @bindThis
  public async storeMemory(
    userId: string,
    content: string,
    type: MemoryType,
    metadata: Partial<MemoryMetadata>,
    importance: number = 0.5
  ): Promise<Memory> {
    const memory: Memory = {
      id: uuid(),
      userId,
      timestamp: Date.now(),
      type,
      content,
      importance: this.normalizeImportance(importance),
      accessCount: 0,
      lastAccessed: Date.now(),
      decay: 1.0,
      metadata: {
        entities: metadata.entities || [],
        source: metadata.source || MemorySource.DIRECT_STATEMENT,
        confidence: metadata.confidence || 0.8,
        tags: metadata.tags || [],
        ...metadata
      }
    };
    
    this.memories.insert(memory);
    
    // Store vector embedding if applicable
    if (type === MemoryType.EPISODIC || type === MemoryType.SEMANTIC) {
      await this.createVectorMemory(memory);
    }
    
    return memory;
  }

  /**
   * クエリに基づいて記憶を取得
   */
  @bindThis
  public async queryMemories(query: MemoryQuery): Promise<Memory[]> {
    let results = this.memories.chain()
      .find({ userId: query.userId })
      .simplesort('timestamp', true);
    
    // Apply filters
    if (query.filters) {
      if (query.filters.type) {
        results = results.find({ type: { $in: query.filters.type } });
      }
      
      if (query.filters.dateRange) {
        results = results.find({
          timestamp: {
            $gte: query.filters.dateRange.start,
            $lte: query.filters.dateRange.end
          }
        });
      }
      
      if (query.filters.importance) {
        results = results.find({
          importance: {
            $gte: query.filters.importance.min,
            $lte: query.filters.importance.max
          }
        });
      }
      
      if (query.filters.tags && query.filters.tags.length > 0) {
        results = results.where((memory: Memory) => 
          query.filters!.tags!.some(tag => memory.metadata.tags.includes(tag))
        );
      }
    }
    
    // Apply pagination
    if (query.offset) {
      results = results.offset(query.offset);
    }
    
    if (query.limit) {
      results = results.limit(query.limit);
    }
    
    const memories = results.data();
    
    // Update access counts
    memories.forEach(memory => {
      memory.accessCount++;
      memory.lastAccessed = Date.now();
      this.memories.update(memory);
    });
    
    return memories;
  }

  /**
   * Get or create short-term memory session
   */
  @bindThis
  public async getOrCreateSession(
    userId: string,
    sessionId?: string
  ): Promise<ShortTermMemory> {
    // Clean up old sessions first
    await this.cleanupOldSessions();
    
    if (sessionId) {
      const existing = this.shortTermMemories.findOne({ sessionId, userId });
      if (existing && Date.now() - existing.lastUpdate < this.SESSION_TIMEOUT) {
        return existing;
      }
    }
    
    // Create new session
    const newSession: ShortTermMemory = {
      sessionId: sessionId || uuid(),
      userId,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      context: {
        topic: '',
        mood: 'neutral',
        intent: '',
        entities: [],
        previousTopics: []
      },
      workingMemory: [],
      attention: {
        primary: '',
        secondary: [],
        weights: {}
      }
    };
    
    this.shortTermMemories.insert(newSession);
    return newSession;
  }

  /**
   * Update short-term memory with new interaction
   */
  @bindThis
  public async updateShortTermMemory(
    sessionId: string,
    item: WorkingMemoryItem,
    context?: Partial<ConversationContext>
  ): Promise<ShortTermMemory> {
    const session = this.shortTermMemories.findOne({ sessionId });
    if (!session) {
      throw new PersonalizationError(
        'Session not found',
        PersonalizationErrorCode.MEMORY_NOT_FOUND
      );
    }
    
    // Add to working memory (FIFO if at capacity)
    session.workingMemory.push(item);
    if (session.workingMemory.length > this.MAX_WORKING_MEMORY_SIZE) {
      session.workingMemory.shift();
    }
    
    // Update context if provided
    if (context) {
      Object.assign(session.context, context);
      
      // Track topic transitions
      if (context.topic && context.topic !== session.context.topic) {
        session.context.previousTopics.push(session.context.topic);
        if (session.context.previousTopics.length > 5) {
          session.context.previousTopics.shift();
        }
      }
    }
    
    // Update attention based on relevance
    this.updateAttention(session, item);
    
    session.lastUpdate = Date.now();
    this.shortTermMemories.update(session);
    
    return session;
  }

  /**
   * Convert important short-term memories to long-term
   */
  @bindThis
  public async consolidateMemories(
    sessionId: string,
    userId: string
  ): Promise<Memory[]> {
    const session = this.shortTermMemories.findOne({ sessionId });
    if (!session) {
      return [];
    }
    
    const consolidatedMemories: Memory[] = [];
    
    // Analyze working memory for important information
    const importantItems = session.workingMemory.filter(
      item => item.relevance > this.IMPORTANCE_THRESHOLD
    );
    
    // Group related items and create episodic memories
    if (importantItems.length > 0) {
      const episodicContent = this.summarizeWorkingMemory(importantItems);
      const episodicMemory = await this.storeMemory(
        userId,
        episodicContent,
        MemoryType.EPISODIC,
        {
          entities: session.context.entities.map(e => e.text),
          context: session.context.topic,
          source: MemorySource.OBSERVED,
          confidence: 0.9,
          tags: ['conversation', session.context.topic]
        },
        this.calculateEpisodicImportance(session)
      );
      consolidatedMemories.push(episodicMemory);
    }
    
    // Extract semantic facts
    const facts = this.extractSemanticFacts(session);
    for (const fact of facts) {
      const semanticMemory = await this.storeMemory(
        userId,
        fact.content,
        MemoryType.SEMANTIC,
        {
          entities: fact.entities,
          source: fact.source,
          confidence: fact.confidence,
          tags: fact.tags
        },
        fact.importance
      );
      consolidatedMemories.push(semanticMemory);
    }
    
    return consolidatedMemories;
  }

  /**
   * Retrieve relevant memories for current context
   */
  @bindThis
  public async retrieveRelevantMemories(
    userId: string,
    context: string,
    limit: number = 5
  ): Promise<Memory[]> {
    // For now, use simple keyword matching
    // In production, this would use vector similarity search
    
    const keywords = this.extractKeywords(context);
    
    const memories = this.memories.chain()
      .find({ userId })
      .where((memory: Memory) => {
        // Check content relevance
        const contentScore = keywords.reduce((score, keyword) => {
          return score + (memory.content.toLowerCase().includes(keyword) ? 1 : 0);
        }, 0) / keywords.length;
        
        // Check tag relevance
        const tagScore = memory.metadata.tags.reduce((score, tag) => {
          return score + (keywords.includes(tag.toLowerCase()) ? 1 : 0);
        }, 0) / Math.max(memory.metadata.tags.length, 1);
        
        // Check entity relevance
        const entityScore = memory.metadata.entities.reduce((score, entity) => {
          return score + (keywords.includes(entity.toLowerCase()) ? 1 : 0);
        }, 0) / Math.max(memory.metadata.entities.length, 1);
        
        // Combined relevance score
        const relevance = (contentScore * 0.5 + tagScore * 0.3 + entityScore * 0.2) * 
                         memory.importance * memory.decay;
        
        return relevance > 0.1;
      })
      .simplesort('importance', true)
      .limit(limit)
      .data();
    
    return memories;
  }

  /**
   * Apply forgetting mechanism
   */
  @bindThis
  public async applyForgetting(userId: string): Promise<void> {
    const memories = this.memories.find({ userId });
    const now = Date.now();
    
    memories.forEach(memory => {
      // Calculate time-based decay
      const monthsSinceCreation = (now - memory.timestamp) / (1000 * 60 * 60 * 24 * 30);
      const timeDecay = Math.pow(this.MEMORY_DECAY_RATE, monthsSinceCreation);
      
      // Access-based boost
      const accessBoost = Math.min(1.5, 1 + memory.accessCount * 0.1);
      
      // Update decay factor
      memory.decay = Math.min(1, timeDecay * accessBoost);
      
      // Remove memories below threshold
      if (memory.decay * memory.importance < 0.1) {
        this.memories.remove(memory);
        
        // Also remove associated vector memory
        const vectorMem = this.vectorMemories.findOne({ memoryId: memory.id });
        if (vectorMem) {
          this.vectorMemories.remove(vectorMem);
        }
      } else {
        this.memories.update(memory);
      }
    });
  }

  /**
   * Delete specific memories
   */
  @bindThis
  public async deleteMemories(userId: string, memoryIds: string[]): Promise<void> {
    const memories = this.memories.find({
      userId,
      id: { $in: memoryIds }
    });
    
    memories.forEach(memory => {
      this.memories.remove(memory);
      
      // Remove associated vector memory
      const vectorMem = this.vectorMemories.findOne({ memoryId: memory.id });
      if (vectorMem) {
        this.vectorMemories.remove(vectorMem);
      }
    });
  }

  /**
   * Get memory statistics for a user
   */
  @bindThis
  public async getMemoryStats(userId: string): Promise<{
    total: number;
    byType: Record<MemoryType, number>;
    averageImportance: number;
    oldestMemory: number | null;
    newestMemory: number | null;
  }> {
    const memories = this.memories.find({ userId });
    
    const stats = {
      total: memories.length,
      byType: {
        [MemoryType.EPISODIC]: 0,
        [MemoryType.SEMANTIC]: 0,
        [MemoryType.PROCEDURAL]: 0,
        [MemoryType.WORKING]: 0
      },
      averageImportance: 0,
      oldestMemory: null as number | null,
      newestMemory: null as number | null
    };
    
    if (memories.length === 0) {
      return stats;
    }
    
    let totalImportance = 0;
    let oldest = Date.now();
    let newest = 0;
    
    memories.forEach(memory => {
      stats.byType[memory.type]++;
      totalImportance += memory.importance;
      
      if (memory.timestamp < oldest) oldest = memory.timestamp;
      if (memory.timestamp > newest) newest = memory.timestamp;
    });
    
    stats.averageImportance = totalImportance / memories.length;
    stats.oldestMemory = oldest;
    stats.newestMemory = newest;
    
    return stats;
  }

  // Private helper methods

  private normalizeImportance(importance: number): number {
    return Math.max(0, Math.min(1, importance));
  }

  private async createVectorMemory(memory: Memory): Promise<void> {
    // In production, this would call an embedding API
    // For now, create a placeholder
    const vectorMemory: VectorMemory = {
      id: uuid(),
      userId: memory.userId,
      content: memory.content,
      embedding: this.generateMockEmbedding(memory.content),
      metadata: {
        memoryId: memory.id,
        type: memory.type,
        importance: memory.importance,
        tags: memory.metadata.tags
      },
      timestamp: memory.timestamp
    };
    
    this.vectorMemories.insert(vectorMemory);
  }

  private generateMockEmbedding(content: string): number[] {
    // Mock embedding generation
    // In production, use OpenAI embeddings or similar
    const embedding = new Array(384).fill(0);
    for (let i = 0; i < content.length; i++) {
      embedding[i % 384] += content.charCodeAt(i) / 1000;
    }
    return embedding.map(v => v / content.length);
  }

  private updateAttention(session: ShortTermMemory, item: WorkingMemoryItem): void {
    // Extract main topic from item
    const topics = this.extractKeywords(item.content);
    
    if (topics.length > 0) {
      // Update primary attention
      session.attention.primary = topics[0];
      
      // Update secondary attention
      session.attention.secondary = topics.slice(1, 4);
      
      // Update weights
      topics.forEach(topic => {
        session.attention.weights[topic] = 
          (session.attention.weights[topic] || 0) + item.relevance;
      });
    }
  }

  private summarizeWorkingMemory(items: WorkingMemoryItem[]): string {
    // Simple concatenation for now
    // In production, use LLM to summarize
    const userInputs = items
      .filter(item => item.type === 'user_input')
      .map(item => item.content)
      .join(' ');
    
    return `Conversation summary: ${userInputs.substring(0, 500)}...`;
  }

  private calculateEpisodicImportance(session: ShortTermMemory): number {
    // Calculate importance based on various factors
    const factors = {
      duration: Math.min(1, (session.lastUpdate - session.startTime) / (1000 * 60 * 30)), // 30 min = 1.0
      interactions: Math.min(1, session.workingMemory.length / 20),
      entities: Math.min(1, session.context.entities.length / 10),
      topicChanges: Math.min(1, session.context.previousTopics.length / 5)
    };
    
    return Object.values(factors).reduce((sum, val) => sum + val, 0) / Object.keys(factors).length;
  }

  private extractSemanticFacts(session: ShortTermMemory): Array<{
    content: string;
    entities: string[];
    source: MemorySource;
    confidence: number;
    tags: string[];
    importance: number;
  }> {
    const facts: Array<{
      content: string;
      entities: string[];
      source: MemorySource;
      confidence: number;
      tags: string[];
      importance: number;
    }> = [];
    
    // Extract facts from user inputs
    session.workingMemory
      .filter(item => item.type === 'user_input')
      .forEach(item => {
        // Simple pattern matching for facts
        const patterns = [
          /I (?:am|work as|do) (.+)/i,
          /My (.+) is (.+)/i,
          /I (?:like|love|enjoy|prefer) (.+)/i,
          /I (?:have|own) (.+)/i
        ];
        
        patterns.forEach(pattern => {
          const match = item.content.match(pattern);
          if (match) {
            facts.push({
              content: match[0],
              entities: session.context.entities.map(e => e.text),
              source: MemorySource.DIRECT_STATEMENT,
              confidence: 0.9,
              tags: [session.context.topic, 'fact'],
              importance: 0.7
            });
          }
        });
      });
    
    return facts;
  }

  private extractKeywords(text: string): string[] {
    // Simple keyword extraction
    // In production, use NLP library
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those'
    ]);
    
    return text
      .toLowerCase()
      .split(/\W+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 10);
  }

  private async cleanupOldSessions(): Promise<void> {
    const cutoff = Date.now() - this.SESSION_TIMEOUT;
    const oldSessions = this.shortTermMemories.find({
      lastUpdate: { $lt: cutoff }
    });
    
    oldSessions.forEach(session => {
      this.shortTermMemories.remove(session);
    });
    
    // Keep only recent sessions
    const allSessions = this.shortTermMemories.chain()
      .simplesort('lastUpdate', true)
      .offset(this.MAX_SHORT_TERM_SESSIONS)
      .data();
    
    allSessions.forEach(session => {
      this.shortTermMemories.remove(session);
    });
  }
}