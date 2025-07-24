/**
 * Long-term Memory implementation with Vector Database
 * Handles persistent, semantic memory storage and retrieval
 */

import { ChromaClient, Collection } from 'chromadb';
import { v4 as uuidv4 } from 'uuid';
import {
  MemoryEntry,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryMetadata,
  PersonalizationError,
  MemoryContent,
  ScoredMemoryEntry,
  MemoryType
} from '../types/index.js';

export class LongTermMemory {
  private client: ChromaClient;
  private collection: Collection | null = null;
  private collectionName: string;
  private embeddingService: EmbeddingService;
  
  constructor(
    chromaUrl: string = 'http://localhost:8000',
    collectionName: string = 'user_memories',
    embeddingService: EmbeddingService
  ) {
    this.client = new ChromaClient({ path: chromaUrl });
    this.collectionName = collectionName;
    this.embeddingService = embeddingService;
  }

  /**
   * Initialize the vector database collection
   */
  async initialize(): Promise<void> {
    try {
      // Try to get existing collection
      this.collection = await this.client.getCollection({
        name: this.collectionName
      });
    } catch (error) {
      // Create new collection if it doesn't exist
      this.collection = await this.client.createCollection({
        name: this.collectionName,
        metadata: { 
          description: 'Long-term memory storage for personalized AI chat'
        }
      });
    }
  }

  /**
   * Store a memory entry
   */
  async storeMemory(
    userId: string,
    content: string,
    type: MemoryType,
    metadata: Partial<MemoryMetadata>,
    context: any
  ): Promise<MemoryEntry> {
    if (!this.collection) {
      await this.initialize();
    }

    const memoryId = uuidv4();
    const now = new Date();

    // Generate embedding for the content
    const embedding = await this.embeddingService.generateEmbedding(content);
    
    // Extract entities and keywords
    const entities = await this.embeddingService.extractEntities(content);
    const keywords = await this.embeddingService.extractKeywords(content);
    
    // Generate summary if not provided
    const summary = metadata.summary || await this.embeddingService.generateSummary(content);

    const memoryEntry: MemoryEntry = {
      id: memoryId,
      userId,
      type,
      content: {
        raw: content,
        summary,
        entities,
        embedding,
        keywords
      },
      metadata: {
        timestamp: now,
        conversationId: metadata.conversationId || '',
        importance: metadata.importance || 0.5,
        emotionalValence: metadata.emotionalValence || 0,
        emotionalArousal: metadata.emotionalArousal || 0,
        accessCount: 0,
        lastAccessedAt: now,
        decayFactor: 1.0,
        consolidationState: 'active',
        verificationStatus: 'unverified',
        ...metadata
      },
      context,
      relationships: {
        relatedMemories: [],
        temporalLinks: [],
        causalLinks: []
      }
    };

    // Store in vector database
    await this.collection!.add({
      ids: [memoryId],
      embeddings: [embedding],
      metadatas: [{
        userId,
        type,
        timestamp: now.toISOString(),
        importance: memoryEntry.metadata.importance,
        emotionalValence: memoryEntry.metadata.emotionalValence,
        keywords: keywords.join(','),
        summary
      }],
      documents: [content]
    });

    // Find and link related memories
    await this.linkRelatedMemories(memoryEntry);

    return memoryEntry;
  }

  /**
   * Search memories using semantic similarity
   */
  async searchMemories(query: MemorySearchQuery): Promise<MemorySearchResult> {
    if (!this.collection) {
      await this.initialize();
    }

    const startTime = Date.now();
    let searchEmbedding: number[] | undefined;

    // Generate embedding for query if provided
    if (query.query) {
      searchEmbedding = await this.embeddingService.generateEmbedding(query.query);
    } else if (query.embedding) {
      searchEmbedding = query.embedding;
    }

    // Build where clause for filtering
    const whereClause: any = { userId: query.userId };
    
    if (query.filters?.type) {
      whereClause.type = { $in: query.filters.type };
    }
    
    if (query.filters?.minImportance) {
      whereClause.importance = { $gte: query.filters.minImportance };
    }

    // Perform vector search
    const results = await this.collection!.query({
      queryEmbeddings: searchEmbedding ? [searchEmbedding] : undefined,
      nResults: query.limit || 10,
      where: whereClause
    });

    // Convert results to memory entries
    const entries: ScoredMemoryEntry[] = [];
    
    if (results.ids && results.ids[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        const memoryId = results.ids[0][i];
        const distance = results.distances?.[0]?.[i] || 0;
        const metadata = results.metadatas?.[0]?.[i] || {};
        const document = results.documents?.[0]?.[i] || '';

        // Retrieve full memory entry (in production, this would be from a database)
        const entry = await this.getMemoryById(memoryId);
        
        if (entry) {
          entries.push({
            ...entry,
            relevanceScore: 1 - (distance / 2), // Convert distance to similarity score
            matchedFields: ['content'], // In a real implementation, track which fields matched
            explanation: `Semantic similarity: ${(1 - distance / 2).toFixed(2)}`
          });
        }
      }
    }

    return {
      entries,
      totalCount: entries.length,
      searchMetadata: {
        executionTime: Date.now() - startTime,
        searchStrategy: searchEmbedding ? 'semantic' : 'keyword',
        appliedFilters: Object.keys(query.filters || {})
      }
    };
  }

  /**
   * Update memory access statistics
   */
  async accessMemory(memoryId: string): Promise<void> {
    const memory = await this.getMemoryById(memoryId);
    if (!memory) return;

    memory.metadata.accessCount++;
    memory.metadata.lastAccessedAt = new Date();
    
    // Update in vector database
    await this.updateMemoryMetadata(memoryId, memory.metadata);
  }

  /**
   * Apply temporal decay to memories
   */
  async applyTemporalDecay(userId: string): Promise<void> {
    const memories = await this.getUserMemories(userId);
    const now = Date.now();

    for (const memory of memories) {
      const age = now - memory.metadata.timestamp.getTime();
      const daysSinceCreation = age / (1000 * 60 * 60 * 24);
      const daysSinceAccess = (now - memory.metadata.lastAccessedAt.getTime()) / (1000 * 60 * 60 * 24);

      // Calculate decay based on age and access patterns
      let decay = 1.0;
      
      // Age-based decay (slower for important memories)
      decay *= Math.exp(-daysSinceCreation * 0.01 * (1 - memory.metadata.importance));
      
      // Access-based boost
      decay *= Math.min(1.5, 1 + (memory.metadata.accessCount * 0.1));
      
      // Recency penalty
      decay *= Math.exp(-daysSinceAccess * 0.05);

      memory.metadata.decayFactor = Math.max(0.1, Math.min(1.0, decay));
      
      await this.updateMemoryMetadata(memory.id, memory.metadata);
    }
  }

  /**
   * Consolidate old memories
   */
  async consolidateMemories(userId: string, threshold: number = 100): Promise<void> {
    const memories = await this.getUserMemories(userId);
    
    if (memories.length <= threshold) {
      return;
    }

    // Sort by importance and decay factor
    memories.sort((a, b) => {
      const scoreA = a.metadata.importance * a.metadata.decayFactor;
      const scoreB = b.metadata.importance * b.metadata.decayFactor;
      return scoreB - scoreA;
    });

    // Keep top memories, consolidate others
    const toKeep = memories.slice(0, threshold);
    const toConsolidate = memories.slice(threshold);

    // Group memories by topic/category for consolidation
    const groups = new Map<string, MemoryEntry[]>();
    
    for (const memory of toConsolidate) {
      const key = `${memory.metadata.category || 'general'}_${memory.type}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(memory);
    }

    // Create consolidated memories
    for (const [key, groupMemories] of groups) {
      if (groupMemories.length > 1) {
        const consolidatedContent = await this.createConsolidatedSummary(groupMemories);
        const [category, type] = key.split('_');
        
        await this.storeMemory(
          userId,
          consolidatedContent,
          type as MemoryType,
          {
            importance: Math.max(...groupMemories.map(m => m.metadata.importance)),
            consolidationState: 'consolidated',
            conversationId: 'consolidated'
          },
          {
            originalMemories: groupMemories.map(m => m.id),
            consolidatedAt: new Date()
          }
        );

        // Mark original memories as archived
        for (const memory of groupMemories) {
          memory.metadata.consolidationState = 'archived';
          await this.updateMemoryMetadata(memory.id, memory.metadata);
        }
      }
    }
  }

  /**
   * Delete a memory
   */
  async deleteMemory(memoryId: string): Promise<void> {
    if (!this.collection) {
      await this.initialize();
    }

    await this.collection!.delete({
      ids: [memoryId]
    });
  }

  /**
   * Delete all memories for a user
   */
  async deleteUserMemories(userId: string): Promise<void> {
    if (!this.collection) {
      await this.initialize();
    }

    const memories = await this.getUserMemories(userId);
    const ids = memories.map(m => m.id);
    
    if (ids.length > 0) {
      await this.collection!.delete({ ids });
    }
  }

  /**
   * Helper methods
   */
  private async getMemoryById(memoryId: string): Promise<MemoryEntry | null> {
    // In a real implementation, this would retrieve from a persistent store
    // For now, we'll reconstruct from vector DB data
    if (!this.collection) return null;

    const result = await this.collection.get({
      ids: [memoryId]
    });

    if (!result.ids || result.ids.length === 0) {
      return null;
    }

    // Reconstruct memory entry from stored data
    // This is a simplified version - in production, store full entries in a database
    return null; // Placeholder
  }

  private async getUserMemories(userId: string): Promise<MemoryEntry[]> {
    const result = await this.searchMemories({
      userId,
      limit: 10000 // Get all memories
    });
    
    return result.entries;
  }

  private async updateMemoryMetadata(memoryId: string, metadata: MemoryMetadata): Promise<void> {
    if (!this.collection) return;

    // Update metadata in vector database
    await this.collection.update({
      ids: [memoryId],
      metadatas: [{
        importance: metadata.importance,
        emotionalValence: metadata.emotionalValence,
        accessCount: metadata.accessCount,
        lastAccessedAt: metadata.lastAccessedAt.toISOString(),
        decayFactor: metadata.decayFactor,
        consolidationState: metadata.consolidationState
      }]
    });
  }

  private async linkRelatedMemories(memory: MemoryEntry): Promise<void> {
    // Find semantically similar memories
    const similar = await this.searchMemories({
      userId: memory.userId,
      embedding: memory.content.embedding,
      limit: 5,
      filters: {
        type: [memory.type]
      }
    });

    // Link memories with high similarity
    for (const related of similar.entries) {
      if (related.id !== memory.id && related.relevanceScore > 0.8) {
        memory.relationships.relatedMemories.push(related.id);
      }
    }
  }

  private async createConsolidatedSummary(memories: MemoryEntry[]): Promise<string> {
    const contents = memories.map(m => m.content.summary || m.content.raw).join('\n\n');
    return await this.embeddingService.generateSummary(contents, {
      maxLength: 500,
      style: 'consolidation'
    });
  }
}

/**
 * Interface for embedding service
 */
export interface EmbeddingService {
  generateEmbedding(text: string): Promise<number[]>;
  extractEntities(text: string): Promise<any[]>;
  extractKeywords(text: string): Promise<string[]>;
  generateSummary(text: string, options?: any): Promise<string>;
}