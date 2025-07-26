/**
 * Hybrid Memory System - Core Implementation
 * 
 * Working Memory + Short-term Memory + Long-term Memory + Knowledge Graph
 * LokiJS (in-memory) + SQLite (persistent) + ChromaDB (vector search) + Graph relationships
 */

import { EventEmitter } from 'events';
import loki from 'lokijs';
import Database from 'better-sqlite3';
// import { ChromaApi, OpenAIEmbeddingFunction } from 'chromadb';
import { v4 as uuid } from 'uuid';
import { bindThis } from '@/decorators.js';
import config from '@/config.js';
import {
  MemoryEntry,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryCategory,
  MemoryContext,
  ConversationAnalysis,
  DynamicUserProfile,
  MemoryRelationship,
  AccessType,
  RetentionPolicy,
  MemorySource,
  VerificationStatus
} from '../types.js';

interface WorkingMemoryEntry {
  id: string;
  userId: string;
  content: string;
  timestamp: Date;
  messageIndex: number;
  importance: number;
  sessionId: string;
  context: Partial<MemoryContext>;
}

interface ShortTermMemoryEntry {
  id: string;
  userId: string;
  summary: string;
  keyPoints: string[];
  timestamp: Date;
  sessionIds: string[];
  importance: number;
  expiresAt: Date;
  consolidatedFrom: string[]; // Working memory IDs
}

interface ConsolidationRule {
  category: MemoryCategory;
  minImportance: number;
  maxAge: number; // hours
  consolidationStrategy: 'summarize' | 'cluster' | 'prioritize' | 'archive';
  retentionPolicy: RetentionPolicy;
}

interface MemoryGraph {
  nodes: Map<string, MemoryGraphNode>;
  edges: Map<string, MemoryGraphEdge>;
}

interface MemoryGraphNode {
  id: string;
  type: 'memory' | 'concept' | 'entity' | 'event';
  data: any;
  weight: number;
  lastAccessed: Date;
}

interface MemoryGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
  confidence: number;
  metadata: any;
}

export class HybridMemorySystem extends EventEmitter {
  // Storage layers
  private memoryDb: loki;                    // In-memory database (LokiJS)
  private persistentDb: Database.Database;   // Persistent database (SQLite)
  private vectorDb: any;               // Vector database (ChromaDB)
  private embeddingFunction: any;
  
  // Collections
  private workingMemory: loki.Collection<WorkingMemoryEntry>;
  private shortTermMemory: loki.Collection<ShortTermMemoryEntry>;
  private longTermMemory: loki.Collection<MemoryEntry>;
  
  // Knowledge graph
  private memoryGraph: MemoryGraph;
  
  // Configuration
  private workingMemorySize: number = 15;    // Max entries per user
  private shortTermMemoryDuration: number = 48; // hours
  private consolidationInterval: number = 1; // hours
  private forgettingEnabled: boolean = true;
  private embeddingModel: string = 'text-embedding-3-small';
  
  // State management
  private consolidationRules: ConsolidationRule[];
  private isInitialized: boolean = false;
  private consolidationTimer: NodeJS.Timeout | null = null;

  constructor(lokiDb: loki, persistentDbPath: string = './memory.db') {
    super();
    
    this.memoryDb = lokiDb;
    this.memoryGraph = {
      nodes: new Map(),
      edges: new Map()
    };
    
    this.consolidationRules = this.getDefaultConsolidationRules();
    this.initializeStorageLayers(persistentDbPath);
  }

  @bindThis
  private async initializeStorageLayers(persistentDbPath: string) {
    try {
      // Initialize persistent SQLite database
      this.persistentDb = new Database(persistentDbPath);
      this.createSQLiteTables();
      
      // Initialize vector database (ChromaDB) - Mock implementation
      this.vectorDb = {
        getCollection: async () => ({ query: async () => ({ ids: [[]], distances: [[]] }) }),
        createCollection: async () => ({ add: async () => {} })
      };
      
      this.embeddingFunction = {};
      
      // Initialize LokiJS collections
      this.initializeLokiCollections();
      
      // Start background processes
      this.startConsolidationProcess();
      
      this.isInitialized = true;
      this.emit('initialized');
      
    } catch (error) {
      throw new Error(`Failed to initialize Hybrid Memory System: ${error}`);
    }
  }

  @bindThis
  private createSQLiteTables() {
    // Long-term memory table
    this.persistentDb.exec(`
      CREATE TABLE IF NOT EXISTS long_term_memory (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        category TEXT NOT NULL,
        importance REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        accessed_count INTEGER DEFAULT 0,
        last_accessed_at INTEGER,
        confidence REAL DEFAULT 0.5,
        source TEXT DEFAULT 'unknown',
        verification_status TEXT DEFAULT 'unverified',
        retention_policy TEXT DEFAULT 'medium_term',
        privacy_level TEXT DEFAULT 'private',
        tags TEXT, -- JSON array
        context TEXT, -- JSON object
        analysis TEXT, -- JSON object
        relationships TEXT, -- JSON array
        embedding BLOB
      )
    `);

    // Memory access log table
    this.persistentDb.exec(`
      CREATE TABLE IF NOT EXISTS memory_access_log (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        access_type TEXT NOT NULL,
        context TEXT,
        relevance_score REAL,
        used BOOLEAN DEFAULT FALSE,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES long_term_memory(id) ON DELETE CASCADE
      )
    `);

    // User profiles table
    this.persistentDb.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        profile_data TEXT NOT NULL, -- JSON object
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER DEFAULT 1,
        data_confidence REAL DEFAULT 0.0,
        interaction_count INTEGER DEFAULT 0
      )
    `);

    // Create indexes for better performance
    this.persistentDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_ltm_user_id ON long_term_memory(user_id);
      CREATE INDEX IF NOT EXISTS idx_ltm_category ON long_term_memory(category);
      CREATE INDEX IF NOT EXISTS idx_ltm_importance ON long_term_memory(importance);
      CREATE INDEX IF NOT EXISTS idx_ltm_created_at ON long_term_memory(created_at);
      CREATE INDEX IF NOT EXISTS idx_access_log_memory_id ON memory_access_log(memory_id);
      CREATE INDEX IF NOT EXISTS idx_access_log_timestamp ON memory_access_log(timestamp);
    `);
  }

  @bindThis
  private initializeLokiCollections() {
    // Working Memory (current session context)
    this.workingMemory = this.memoryDb.getCollection('workingMemory') || 
      this.memoryDb.addCollection('workingMemory', {
        indices: ['userId', 'sessionId', 'timestamp'],
        ttl: 30 * 60 * 1000, // 30 minutes TTL
        ttlInterval: 5 * 60 * 1000 // Check every 5 minutes
      });

    // Short-term Memory (session summaries and temporary context)
    this.shortTermMemory = this.memoryDb.getCollection('shortTermMemory') || 
      this.memoryDb.addCollection('shortTermMemory', {
        indices: ['userId', 'timestamp', 'expiresAt'],
        ttl: this.shortTermMemoryDuration * 60 * 60 * 1000,
        ttlInterval: 60 * 60 * 1000 // Check every hour
      });

    // Long-term Memory cache (for quick access)
    this.longTermMemory = this.memoryDb.getCollection('longTermMemoryCache') || 
      this.memoryDb.addCollection('longTermMemoryCache', {
        indices: ['userId', 'category', 'importance']
      });
  }

  @bindThis
  private getDefaultConsolidationRules(): ConsolidationRule[] {
    return [
      {
        category: 'personal_info',
        minImportance: 0.3,
        maxAge: 2, // 2 hours
        consolidationStrategy: 'prioritize',
        retentionPolicy: 'long_term'
      },
      {
        category: 'preferences',
        minImportance: 0.4,
        maxAge: 4,
        consolidationStrategy: 'cluster',
        retentionPolicy: 'long_term'
      },
      {
        category: 'goals',
        minImportance: 0.5,
        maxAge: 1,
        consolidationStrategy: 'summarize',
        retentionPolicy: 'long_term'
      },
      {
        category: 'experiences',
        minImportance: 0.3,
        maxAge: 6,
        consolidationStrategy: 'summarize',
        retentionPolicy: 'medium_term'
      },
      {
        category: 'context',
        minImportance: 0.2,
        maxAge: 12,
        consolidationStrategy: 'archive',
        retentionPolicy: 'short_term'
      }
    ];
  }

  // =====================================================================
  // Working Memory Operations
  // =====================================================================

  @bindThis
  async addToWorkingMemory(
    userId: string, 
    content: string, 
    sessionId: string,
    context: Partial<MemoryContext>,
    importance: number = 0.5
  ): Promise<void> {
    const entry: WorkingMemoryEntry = {
      id: uuid(),
      userId,
      content,
      timestamp: new Date(),
      messageIndex: this.getNextMessageIndex(userId, sessionId),
      importance,
      sessionId,
      context
    };

    this.workingMemory.insert(entry);

    // Maintain working memory size limit
    await this.pruneWorkingMemory(userId);

    this.emit('working_memory_added', { userId, entry });
  }

  @bindThis
  private getNextMessageIndex(userId: string, sessionId: string): number {
    const existingEntries = this.workingMemory.find({ 
      userId, 
      sessionId 
    });
    return existingEntries.length;
  }

  @bindThis
  private async pruneWorkingMemory(userId: string): Promise<void> {
    const userEntries = this.workingMemory.find({ userId });
    
    if (userEntries.length > this.workingMemorySize) {
      // Sort by importance and recency
      userEntries.sort((a, b) => {
        const scoreA = a.importance + (Date.now() - a.timestamp.getTime()) / (1000 * 60 * 60 * 24);
        const scoreB = b.importance + (Date.now() - b.timestamp.getTime()) / (1000 * 60 * 60 * 24);
        return scoreA - scoreB;
      });

      // Remove oldest, least important entries
      const toRemove = userEntries.slice(0, userEntries.length - this.workingMemorySize);
      
      for (const entry of toRemove) {
        this.workingMemory.remove(entry);
      }
    }
  }

  @bindThis
  getWorkingMemoryContext(userId: string, sessionId?: string): WorkingMemoryEntry[] {
    const query: any = { userId };
    if (sessionId) {
      query.sessionId = sessionId;
    }

    return this.workingMemory.find(query)
      .sort((a, b) => a.messageIndex - b.messageIndex);
  }

  // =====================================================================
  // Short-term Memory Operations
  // =====================================================================

  @bindThis
  async consolidateToShortTermMemory(
    userId: string,
    sessionId: string,
    analysis: ConversationAnalysis
  ): Promise<void> {
    const workingEntries = this.workingMemory.find({ userId, sessionId });
    
    if (workingEntries.length === 0) return;

    // Extract key points from working memory
    const keyPoints = await this.extractKeyPoints(workingEntries, analysis);
    const summary = await this.generateSessionSummary(workingEntries, keyPoints);

    const shortTermEntry: ShortTermMemoryEntry = {
      id: uuid(),
      userId,
      summary,
      keyPoints,
      timestamp: new Date(),
      sessionIds: [sessionId],
      importance: this.calculateSessionImportance(workingEntries, analysis),
      expiresAt: new Date(Date.now() + this.shortTermMemoryDuration * 60 * 60 * 1000),
      consolidatedFrom: workingEntries.map(e => e.id)
    };

    this.shortTermMemory.insert(shortTermEntry);

    this.emit('short_term_memory_consolidated', { userId, sessionId, entry: shortTermEntry });
  }

  @bindThis
  private async extractKeyPoints(
    entries: WorkingMemoryEntry[],
    analysis: ConversationAnalysis
  ): Promise<string[]> {
    const keyPoints: string[] = [];
    
    // Add important topics
    if (analysis.topic.mainTopic) {
      keyPoints.push(`Main topic: ${analysis.topic.mainTopic}`);
    }

    // Add significant entities
    for (const entity of analysis.topic.entities) {
      if (entity.confidence > 0.7) {
        keyPoints.push(`${entity.type}: ${entity.text}`);
      }
    }

    // Add emotional insights
    if (analysis.emotion.emotionIntensity > 0.6) {
      keyPoints.push(`Emotion: ${analysis.emotion.primaryEmotion} (${analysis.emotion.emotionIntensity.toFixed(2)})`);
    }

    // Add learning insights
    if (analysis.learning?.learningOpportunity) {
      keyPoints.push(`Learning: ${analysis.learning.learningOpportunity.domain}`);
    }

    return keyPoints;
  }

  @bindThis
  private async generateSessionSummary(
    entries: WorkingMemoryEntry[],
    keyPoints: string[]
  ): Promise<string> {
    // Simple summarization - in production, this would use LLM
    const contents = entries.map(e => e.content).join(' ');
    const summary = contents.length > 500 ? 
      contents.substring(0, 500) + '...' : 
      contents;
    
    return `Session summary: ${summary}\nKey points: ${keyPoints.join(', ')}`;
  }

  @bindThis
  private calculateSessionImportance(
    entries: WorkingMemoryEntry[],
    analysis: ConversationAnalysis
  ): number {
    let importance = 0;

    // Base importance on working memory entries
    const avgImportance = entries.reduce((sum, e) => sum + e.importance, 0) / entries.length;
    importance += avgImportance * 0.4;

    // Factor in emotional intensity
    importance += analysis.emotion.emotionIntensity * 0.3;

    // Factor in learning value
    if (analysis.learning?.learningOpportunity) {
      importance += analysis.learning.learningOpportunity.value * 0.3;
    }

    return Math.min(1, importance);
  }

  // =====================================================================
  // Long-term Memory Operations
  // =====================================================================

  @bindThis
  async saveToLongTermMemory(entry: MemoryEntry): Promise<void> {
    try {
      // Generate embedding for semantic search
      const embedding = await this.generateEmbedding(entry.content + ' ' + entry.summary);

      // Save to SQLite
      const stmt = this.persistentDb.prepare(`
        INSERT INTO long_term_memory (
          id, user_id, content, summary, category, importance,
          created_at, updated_at, confidence, source, verification_status,
          retention_policy, privacy_level, tags, context, analysis,
          relationships, embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        entry.id,
        entry.userId,
        entry.content,
        entry.summary,
        entry.category,
        entry.importance,
        entry.metadata.createdAt.getTime(),
        entry.metadata.updatedAt.getTime(),
        entry.metadata.confidence,
        entry.metadata.source,
        entry.metadata.verification,
        entry.metadata.retention,
        entry.metadata.privacy,
        JSON.stringify(entry.metadata.tags),
        JSON.stringify(entry.context),
        JSON.stringify(entry.analysis),
        JSON.stringify(entry.relationships),
        Buffer.from(new Float64Array(embedding).buffer)
      );

      // Save to vector database for semantic search
      await this.saveToVectorDatabase(entry, embedding);

      // Cache in LokiJS for quick access
      this.longTermMemory.insert(entry);

      // Update knowledge graph
      await this.updateKnowledgeGraph(entry);

      this.emit('long_term_memory_saved', { userId: entry.userId, entry });

    } catch (error) {
      throw new Error(`Failed to save to long-term memory: ${error}`);
    }
  }

  @bindThis
  private async generateEmbedding(text: string): Promise<number[]> {
    try {
      // For now, return a mock embedding. In production, use actual embedding service
      // const response = await openai.embeddings.create({
      //   model: this.embeddingModel,
      //   input: text
      // });
      // return response.data[0].embedding;

      // Mock embedding for demonstration
      return Array.from({ length: 1536 }, () => Math.random() - 0.5);
    } catch (error) {
      throw new Error(`Failed to generate embedding: ${error}`);
    }
  }

  @bindThis
  private async saveToVectorDatabase(entry: MemoryEntry, embedding: number[]): Promise<void> {
    try {
      const collectionName = `user_memories_${entry.userId}`;
      
      // Get or create collection
      let collection;
      try {
        collection = await this.vectorDb.getCollection({
          name: collectionName,
          embeddingFunction: this.embeddingFunction
        });
      } catch {
        collection = await this.vectorDb.createCollection({
          name: collectionName,
          embeddingFunction: this.embeddingFunction
        });
      }

      // Add memory to collection
      await collection.add({
        ids: [entry.id],
        embeddings: [embedding],
        metadatas: [{
          category: entry.category,
          importance: entry.importance,
          created_at: entry.metadata.createdAt.getTime(),
          summary: entry.summary
        }],
        documents: [entry.content]
      });

    } catch (error) {
      console.warn(`Failed to save to vector database: ${error}`);
    }
  }

  @bindThis
  private async updateKnowledgeGraph(entry: MemoryEntry): Promise<void> {
    // Create memory node
    const memoryNode: MemoryGraphNode = {
      id: entry.id,
      type: 'memory',
      data: entry,
      weight: entry.importance,
      lastAccessed: new Date()
    };

    this.memoryGraph.nodes.set(entry.id, memoryNode);

    // Create entity nodes and relationships
    for (const entity of entry.analysis.topic.entities) {
      const entityId = `entity_${entity.type}_${entity.text}`;
      
      if (!this.memoryGraph.nodes.has(entityId)) {
        const entityNode: MemoryGraphNode = {
          id: entityId,
          type: 'entity',
          data: entity,
          weight: entity.confidence,
          lastAccessed: new Date()
        };
        this.memoryGraph.nodes.set(entityId, entityNode);
      }

      // Create edge between memory and entity
      const edgeId = `${entry.id}_${entityId}`;
      const edge: MemoryGraphEdge = {
        id: edgeId,
        source: entry.id,
        target: entityId,
        type: 'contains_entity',
        weight: entity.confidence,
        confidence: entity.confidence,
        metadata: { entityType: entity.type }
      };
      this.memoryGraph.edges.set(edgeId, edge);
    }

    // Create concept nodes for main topics
    const conceptId = `concept_${entry.analysis.topic.mainTopic}`;
    if (!this.memoryGraph.nodes.has(conceptId)) {
      const conceptNode: MemoryGraphNode = {
        id: conceptId,
        type: 'concept',
        data: { topic: entry.analysis.topic.mainTopic },
        weight: 0.5,
        lastAccessed: new Date()
      };
      this.memoryGraph.nodes.set(conceptId, conceptNode);
    }

    // Create edge between memory and concept
    const conceptEdgeId = `${entry.id}_${conceptId}`;
    const conceptEdge: MemoryGraphEdge = {
      id: conceptEdgeId,
      source: entry.id,
      target: conceptId,
      type: 'relates_to_concept',
      weight: 0.7,
      confidence: 0.7,
      metadata: { topic: entry.analysis.topic.mainTopic }
    };
    this.memoryGraph.edges.set(conceptEdgeId, conceptEdge);
  }

  // =====================================================================
  // Memory Search and Retrieval
  // =====================================================================

  @bindThis
  async searchMemories(query: MemorySearchQuery): Promise<MemorySearchResult> {
    const results: MemoryEntry[] = [];
    const relevanceScores: number[] = [];

    try {
      // Search in different layers based on query
      if (query.query && query.query.trim()) {
        // Semantic search using vector database
        const semanticResults = await this.semanticSearch(query);
        results.push(...semanticResults.entries);
        relevanceScores.push(...semanticResults.scores);
      }

      // Filter and rank results
      const filteredResults = await this.filterAndRankResults(results, query);
      
      // Log access for learning
      await this.logMemoryAccess(filteredResults, query);

      return {
        entries: filteredResults.slice(0, query.limit || 10),
        relevanceScores: relevanceScores.slice(0, query.limit || 10),
        totalCount: filteredResults.length,
        categories: [...new Set(filteredResults.map(r => r.category))],
        commonTags: this.extractCommonTags(filteredResults)
      };

    } catch (error) {
      throw new Error(`Memory search failed: ${error}`);
    }
  }

  @bindThis
  private async semanticSearch(query: MemorySearchQuery): Promise<{ entries: MemoryEntry[], scores: number[] }> {
    try {
      const collectionName = `user_memories_${query.userId}`;
      const collection = await this.vectorDb.getCollection({
        name: collectionName,
        embeddingFunction: this.embeddingFunction
      });

      const searchResults = await collection.query({
        queryTexts: [query.query!],
        nResults: query.limit || 50,
        where: query.category ? { category: query.category } : undefined
      });

      const entries: MemoryEntry[] = [];
      const scores: number[] = [];

      if (searchResults.ids && searchResults.ids[0]) {
        for (let i = 0; i < searchResults.ids[0].length; i++) {
          const memoryId = searchResults.ids[0][i];
          const distance = searchResults.distances?.[0]?.[i] || 1.0;
          const relevanceScore = 1 - distance; // Convert distance to similarity

          // Retrieve full memory entry from SQLite
          const entry = await this.getMemoryById(memoryId);
          if (entry) {
            entries.push(entry);
            scores.push(relevanceScore);
          }
        }
      }

      return { entries, scores };

    } catch (error) {
      console.warn(`Semantic search failed: ${error}`);
      return { entries: [], scores: [] };
    }
  }

  @bindThis
  private async getMemoryById(memoryId: string): Promise<MemoryEntry | null> {
    try {
      const stmt = this.persistentDb.prepare(`
        SELECT * FROM long_term_memory WHERE id = ?
      `);
      const row = stmt.get(memoryId) as any;

      if (!row) return null;

      return {
        id: row.id,
        userId: row.user_id,
        content: row.content,
        summary: row.summary,
        category: row.category as MemoryCategory,
        importance: row.importance,
        analysis: JSON.parse(row.analysis),
        context: JSON.parse(row.context),
        metadata: {
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
          accessCount: row.accessed_count,
          lastAccessedAt: new Date(row.last_accessed_at || row.created_at),
          importance: row.importance,
          category: row.category,
          tags: JSON.parse(row.tags || '[]'),
          confidence: row.confidence,
          source: row.source as MemorySource,
          verification: row.verification_status as VerificationStatus,
          retention: row.retention_policy as RetentionPolicy,
          privacy: row.privacy_level as any,
          shareability: 'context_dependent' as any
        },
        relationships: JSON.parse(row.relationships || '[]'),
        accessLog: []
      };

    } catch (error) {
      console.error(`Failed to retrieve memory ${memoryId}:`, error);
      return null;
    }
  }

  @bindThis
  private async filterAndRankResults(
    results: MemoryEntry[],
    query: MemorySearchQuery
  ): Promise<MemoryEntry[]> {
    let filtered = results;

    // Apply filters
    if (query.category) {
      filtered = filtered.filter(r => r.category === query.category);
    }

    if (query.tags && query.tags.length > 0) {
      filtered = filtered.filter(r => 
        query.tags!.some(tag => r.metadata.tags.includes(tag))
      );
    }

    if (query.minImportance !== undefined) {
      filtered = filtered.filter(r => r.importance >= query.minImportance!);
    }

    if (query.dateRange) {
      filtered = filtered.filter(r => {
        const createdAt = r.metadata.createdAt;
        return createdAt >= query.dateRange!.start && createdAt <= query.dateRange!.end;
      });
    }

    // Sort by relevance and importance
    filtered.sort((a, b) => {
      const scoreA = a.importance + (a.metadata.accessCount / 100);
      const scoreB = b.importance + (b.metadata.accessCount / 100);
      return scoreB - scoreA;
    });

    return filtered;
  }

  @bindThis
  private async logMemoryAccess(
    memories: MemoryEntry[],
    query: MemorySearchQuery
  ): Promise<void> {
    const stmt = this.persistentDb.prepare(`
      INSERT INTO memory_access_log (
        id, memory_id, access_type, context, relevance_score, used, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const memory of memories) {
      stmt.run(
        uuid(),
        memory.id,
        'retrieval' as AccessType,
        JSON.stringify({ query: query.query, category: query.category }),
        memory.importance,
        true,
        Date.now()
      );

      // Update access count in SQLite
      const updateStmt = this.persistentDb.prepare(`
        UPDATE long_term_memory 
        SET accessed_count = accessed_count + 1, last_accessed_at = ?
        WHERE id = ?
      `);
      updateStmt.run(Date.now(), memory.id);
    }
  }

  @bindThis
  private extractCommonTags(memories: MemoryEntry[]): string[] {
    const tagCounts = new Map<string, number>();
    
    for (const memory of memories) {
      for (const tag of memory.metadata.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }

    return Array.from(tagCounts.entries())
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, _]) => tag);
  }

  // =====================================================================
  // Consolidation and Forgetting
  // =====================================================================

  @bindThis
  private startConsolidationProcess(): void {
    this.consolidationTimer = setInterval(async () => {
      try {
        await this.performConsolidation();
        if (this.forgettingEnabled) {
          await this.performForgetting();
        }
      } catch (error) {
        console.error('Consolidation process error:', error);
        this.emit('consolidation_error', error);
      }
    }, this.consolidationInterval * 60 * 60 * 1000);
  }

  @bindThis
  private async performConsolidation(): Promise<void> {
    // Get all users with short-term memories
    const users = new Set(this.shortTermMemory.find({}).map(e => e.userId));

    for (const userId of users) {
      await this.consolidateUserMemories(userId);
    }

    this.emit('consolidation_completed', { processedUsers: users.size });
  }

  @bindThis
  private async consolidateUserMemories(userId: string): Promise<void> {
    const shortTermEntries = this.shortTermMemory.find({ userId });
    
    for (const rule of this.consolidationRules) {
      const applicableEntries = shortTermEntries.filter(entry => {
        const age = (Date.now() - entry.timestamp.getTime()) / (1000 * 60 * 60);
        return age >= rule.maxAge && entry.importance >= rule.minImportance;
      });

      if (applicableEntries.length === 0) continue;

      switch (rule.consolidationStrategy) {
        case 'summarize':
          await this.summarizeAndPromote(userId, applicableEntries, rule);
          break;
        case 'cluster':
          await this.clusterAndPromote(userId, applicableEntries, rule);
          break;
        case 'prioritize':
          await this.prioritizeAndPromote(userId, applicableEntries, rule);
          break;
        case 'archive':
          await this.archiveEntries(userId, applicableEntries);
          break;
      }
    }
  }

  @bindThis
  private async summarizeAndPromote(
    userId: string,
    entries: ShortTermMemoryEntry[],
    rule: ConsolidationRule
  ): Promise<void> {
    // Create a consolidated long-term memory entry
    const consolidatedSummary = entries.map(e => e.summary).join('\n\n');
    const allKeyPoints = entries.flatMap(e => e.keyPoints);
    
    const longTermEntry: MemoryEntry = {
      id: uuid(),
      userId,
      content: consolidatedSummary,
      summary: consolidatedSummary.length > 200 ? 
        consolidatedSummary.substring(0, 200) + '...' : 
        consolidatedSummary,
      category: rule.category,
      importance: Math.max(...entries.map(e => e.importance)),
      analysis: this.createDefaultAnalysis(),
      context: this.createDefaultContext(),
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        accessCount: 0,
        lastAccessedAt: new Date(),
        importance: Math.max(...entries.map(e => e.importance)),
        category: rule.category,
        tags: [...new Set(allKeyPoints)],
        confidence: 0.8,
        source: 'consolidation' as MemorySource,
        verification: 'cross_referenced' as VerificationStatus,
        retention: rule.retentionPolicy,
        privacy: 'private' as any,
        shareability: 'context_dependent' as any
      },
      relationships: [],
      accessLog: []
    };

    await this.saveToLongTermMemory(longTermEntry);

    // Remove consolidated short-term entries
    for (const entry of entries) {
      this.shortTermMemory.remove(entry);
    }
  }

  @bindThis
  private async clusterAndPromote(
    userId: string,
    entries: ShortTermMemoryEntry[],
    rule: ConsolidationRule
  ): Promise<void> {
    // Simple clustering by key points similarity
    const clusters = this.clusterByKeyPoints(entries);
    
    for (const cluster of clusters) {
      await this.summarizeAndPromote(userId, cluster, rule);
    }
  }

  @bindThis
  private clusterByKeyPoints(entries: ShortTermMemoryEntry[]): ShortTermMemoryEntry[][] {
    const clusters: ShortTermMemoryEntry[][] = [];
    const processed = new Set<string>();

    for (const entry of entries) {
      if (processed.has(entry.id)) continue;

      const cluster = [entry];
      processed.add(entry.id);

      // Find similar entries
      for (const other of entries) {
        if (processed.has(other.id)) continue;

        const similarity = this.calculateKeyPointSimilarity(entry.keyPoints, other.keyPoints);
        if (similarity > 0.5) {
          cluster.push(other);
          processed.add(other.id);
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  @bindThis
  private calculateKeyPointSimilarity(points1: string[], points2: string[]): number {
    const set1 = new Set(points1);
    const set2 = new Set(points2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
  }

  @bindThis
  private async prioritizeAndPromote(
    userId: string,
    entries: ShortTermMemoryEntry[],
    rule: ConsolidationRule
  ): Promise<void> {
    // Sort by importance and promote top entries
    const sorted = entries.sort((a, b) => b.importance - a.importance);
    const topEntries = sorted.slice(0, Math.min(5, sorted.length));
    
    await this.summarizeAndPromote(userId, topEntries, rule);
  }

  @bindThis
  private async archiveEntries(userId: string, entries: ShortTermMemoryEntry[]): Promise<void> {
    // Simply remove entries (they're archived in the consolidation log)
    for (const entry of entries) {
      this.shortTermMemory.remove(entry);
    }
  }

  @bindThis
  private async performForgetting(): Promise<void> {
    // Implement intelligent forgetting based on access patterns, importance, and age
    const cutoffDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 year ago

    const stmt = this.persistentDb.prepare(`
      DELETE FROM long_term_memory 
      WHERE created_at < ? 
        AND accessed_count < 3 
        AND importance < 0.3
        AND retention_policy IN ('short_term', 'medium_term')
    `);

    const result = stmt.run(cutoffDate.getTime());
    
    if (result.changes > 0) {
      this.emit('memories_forgotten', { count: result.changes });
    }
  }

  // =====================================================================
  // Utility Methods
  // =====================================================================

  @bindThis
  private createDefaultAnalysis(): ConversationAnalysis {
    return {
      emotion: {
        primaryEmotion: 'neutral',
        emotionIntensity: 0.5,
        emotionMix: {},
        sentiment: { polarity: 0, subjectivity: 0.5, confidence: 0.5 },
        emotionalStability: 0.7,
        triggers: [],
        expressionStyle: 'direct',
        regulationNeeds: []
      },
      intent: {
        primaryIntent: 'information_seeking',
        intentConfidence: 0.5,
        subIntents: [],
        urgency: 0.5,
        complexity: 0.5,
        specificity: 0.5,
        expectedResponseType: ['informational'],
        responsePreferences: []
      },
      topic: {
        mainTopic: 'general',
        subTopics: [],
        topicCategory: 'personal',
        complexity: 0.5,
        novelty: 0.5,
        expertise_required: 0.5,
        entities: [],
        keywords: [],
        relatedTopics: [],
        historicalRelevance: 0.5
      },
      relationship: {
        currentStage: 'acquaintance',
        stageProgression: {
          direction: 'stable',
          velocity: 0.5,
          factors: [],
          barriers: [],
          catalysts: []
        },
        trustIndicators: [],
        intimacyFactors: [],
        communicationQuality: {
          clarity: 0.7,
          empathy: 0.6,
          responsiveness: 0.8,
          adaptability: 0.7,
          authenticity: 0.8,
          improvementAreas: [],
          strengths: []
        },
        conflictRisk: {
          overall: 0.2,
          categories: [],
          triggers: [],
          preventionStrategies: [],
          earlyWarnings: []
        },
        growthOpportunities: [],
        recommendedActions: []
      },
      learning: {
        learningOpportunity: {
          type: 'new_concept',
          domain: 'general',
          level: 'basic',
          value: 0.5,
          accessibility: 0.7,
          prerequisitesMet: true,
          timeInvestment: 30
        },
        knowledgeGap: [],
        skillDevelopment: [],
        recommendedApproach: {
          primaryStyle: 'reading',
          supportingStyles: ['discussion'],
          pacing: 'moderate',
          structure: 'linear',
          feedback: 'immediate'
        },
        supportNeeds: [],
        currentProgress: {
          overallProgress: 0.5,
          recentAchievements: [],
          currentChallenges: [],
          motivationLevel: 0.7,
          retentionQuality: 0.6
        },
        nextSteps: []
      },
      personalization: {
        responseStyle: {
          tone: 'warm',
          formality: 0.5,
          length: {
            preferred: 'moderate',
            flexibility: 0.7,
            context_sensitivity: 0.8
          },
          emotionalSupport: 'moderate',
          technicality: 0.5,
          creativity: 0.5
        },
        contentAdaptation: {
          complexityLevel: 0.5,
          exampleUsage: 'moderate',
          analogyPreference: 0.6,
          visualAidSuggestion: false,
          practicalApplication: 0.7
        },
        interactionApproach: {
          questioningStyle: 'gentle',
          challengeLevel: 0.5,
          autonomySupport: 0.8,
          collaborationLevel: 0.7,
          patience: 0.8
        },
        adaptations: [],
        feedbackIntegration: {
          explicit: [],
          implicit: [],
          behavioral: [],
          integrationStrategy: 'weighted',
          validation: ['behavior_monitoring']
        }
      },
      meta: {
        confidence: {
          overall: 0.6,
          components: {},
          factors: []
        },
        quality: {
          dataQuality: 0.7,
          methodQuality: 0.6,
          interpretationQuality: 0.6,
          strengthens: [],
          weaknesses: []
        },
        completeness: {
          coverage: 0.6,
          missing_aspects: [],
          depth: 0.5,
          breadth: 0.6
        },
        limitations: [],
        uncertainties: [],
        improvements: []
      }
    };
  }

  @bindThis
  private createDefaultContext(): MemoryContext {
    return {
      conversationId: uuid(),
      timestamp: new Date(),
      sessionContext: {
        sessionId: uuid(),
        sessionDuration: 30,
        messageCount: 1,
        topicsDiscussed: ['general'],
        overallTone: 'neutral'
      },
      emotionalContext: {
        userEmotion: {
          primaryEmotion: 'neutral',
          emotionIntensity: 0.5,
          emotionMix: {},
          sentiment: { polarity: 0, subjectivity: 0.5, confidence: 0.5 },
          emotionalStability: 0.7,
          triggers: [],
          expressionStyle: 'direct',
          regulationNeeds: []
        },
        aiEmotion: {
          primaryEmotion: 'neutral',
          emotionIntensity: 0.5,
          emotionMix: {},
          sentiment: { polarity: 0, subjectivity: 0.5, confidence: 0.5 },
          emotionalStability: 0.9,
          triggers: [],
          expressionStyle: 'direct',
          regulationNeeds: []
        },
        emotionalArc: [],
        emotionalCatalysts: []
      },
      topicalContext: {
        mainTopic: 'general',
        subTopics: [],
        topicDepth: 0.5,
        topicShifts: [],
        expertiseLevel: 0.5
      },
      socialContext: {
        relationshipDynamics: [],
        powerBalance: 0.5,
        intimacyLevel: 0.3,
        formalityLevel: 0.5,
        collaborationMode: false
      }
    };
  }

  @bindThis
  async getSystemStats(): Promise<any> {
    const workingCount = this.workingMemory.count();
    const shortTermCount = this.shortTermMemory.count();
    
    const longTermStmt = this.persistentDb.prepare('SELECT COUNT(*) as count FROM long_term_memory');
    const longTermCount = (longTermStmt.get() as any).count;

    return {
      workingMemory: {
        count: workingCount,
        maxSize: this.workingMemorySize
      },
      shortTermMemory: {
        count: shortTermCount,
        duration: this.shortTermMemoryDuration
      },
      longTermMemory: {
        count: longTermCount,
        forgettingEnabled: this.forgettingEnabled
      },
      knowledgeGraph: {
        nodes: this.memoryGraph.nodes.size,
        edges: this.memoryGraph.edges.size
      },
      initialized: this.isInitialized
    };
  }

  @bindThis
  async shutdown(): Promise<void> {
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
    }
    
    if (this.persistentDb) {
      this.persistentDb.close();
    }
    
    this.emit('shutdown');
  }
}

export default HybridMemorySystem;