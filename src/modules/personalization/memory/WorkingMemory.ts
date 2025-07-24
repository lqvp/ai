/**
 * Working Memory implementation using Redis
 * Handles short-term, session-based memory storage
 */

import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { 
  WorkingMemory as IWorkingMemory,
  Message,
  Entity,
  ConversationState,
  PersonalizationError,
  ConversationContext
} from '../types/index.js';

export class WorkingMemory {
  private redis: Redis;
  private ttl: number; // Time to live in seconds
  
  constructor(redisUrl: string = 'redis://localhost:6379', ttl: number = 86400) {
    this.redis = new Redis(redisUrl);
    this.ttl = ttl; // Default 24 hours
  }

  /**
   * Initialize a new conversation session
   */
  async createSession(userId: string): Promise<ConversationState> {
    const sessionId = uuidv4();
    const now = new Date();
    
    const conversationState: ConversationState = {
      sessionId,
      userId,
      startedAt: now,
      lastMessageAt: now,
      status: 'active',
      context: this.createEmptyContext(),
      workingMemory: {
        recentMessages: [],
        activeEntities: new Map(),
        currentFocus: [],
        shortTermGoals: []
      }
    };

    await this.saveSession(conversationState);
    return conversationState;
  }

  /**
   * Get or create a conversation session
   */
  async getOrCreateSession(userId: string): Promise<ConversationState> {
    const sessions = await this.getActiveSessions(userId);
    
    if (sessions.length > 0) {
      // Return the most recent active session
      return sessions[0];
    }
    
    return this.createSession(userId);
  }

  /**
   * Save conversation state to Redis
   */
  async saveSession(state: ConversationState): Promise<void> {
    const key = this.getSessionKey(state.sessionId);
    const data = this.serializeState(state);
    
    await this.redis.setex(key, this.ttl, data);
    
    // Also maintain a user's session index
    const userKey = this.getUserSessionsKey(state.userId);
    await this.redis.zadd(userKey, Date.now(), state.sessionId);
    await this.redis.expire(userKey, this.ttl);
  }

  /**
   * Get conversation state from Redis
   */
  async getSession(sessionId: string): Promise<ConversationState | null> {
    const key = this.getSessionKey(sessionId);
    const data = await this.redis.get(key);
    
    if (!data) {
      return null;
    }
    
    return this.deserializeState(data);
  }

  /**
   * Get all active sessions for a user
   */
  async getActiveSessions(userId: string): Promise<ConversationState[]> {
    const userKey = this.getUserSessionsKey(userId);
    const sessionIds = await this.redis.zrevrange(userKey, 0, -1);
    
    const sessions: ConversationState[] = [];
    for (const sessionId of sessionIds) {
      const session = await this.getSession(sessionId);
      if (session && session.status === 'active') {
        sessions.push(session);
      }
    }
    
    return sessions;
  }

  /**
   * Add a message to the working memory
   */
  async addMessage(sessionId: string, message: Message): Promise<void> {
    const state = await this.getSession(sessionId);
    if (!state) {
      throw new PersonalizationError(
        'Session not found',
        'PROFILE_NOT_FOUND',
        { sessionId }
      );
    }

    // Add to recent messages (keep last 50)
    state.workingMemory.recentMessages.push(message);
    if (state.workingMemory.recentMessages.length > 50) {
      state.workingMemory.recentMessages.shift();
    }

    // Update last message timestamp
    state.lastMessageAt = new Date();

    // Extract and update entities
    if (message.metadata?.entities) {
      for (const entity of message.metadata.entities) {
        state.workingMemory.activeEntities.set(entity.text, entity);
      }
    }

    await this.saveSession(state);
  }

  /**
   * Update the current focus of the conversation
   */
  async updateFocus(sessionId: string, focus: string[]): Promise<void> {
    const state = await this.getSession(sessionId);
    if (!state) {
      throw new PersonalizationError(
        'Session not found',
        'PROFILE_NOT_FOUND',
        { sessionId }
      );
    }

    state.workingMemory.currentFocus = focus;
    await this.saveSession(state);
  }

  /**
   * Update short-term goals
   */
  async updateGoals(sessionId: string, goals: string[]): Promise<void> {
    const state = await this.getSession(sessionId);
    if (!state) {
      throw new PersonalizationError(
        'Session not found',
        'PROFILE_NOT_FOUND',
        { sessionId }
      );
    }

    state.workingMemory.shortTermGoals = goals;
    await this.saveSession(state);
  }

  /**
   * Get recent messages from working memory
   */
  async getRecentMessages(
    sessionId: string, 
    limit: number = 10
  ): Promise<Message[]> {
    const state = await this.getSession(sessionId);
    if (!state) {
      return [];
    }

    const messages = state.workingMemory.recentMessages;
    return messages.slice(-limit);
  }

  /**
   * Get active entities from the conversation
   */
  async getActiveEntities(sessionId: string): Promise<Entity[]> {
    const state = await this.getSession(sessionId);
    if (!state) {
      return [];
    }

    return Array.from(state.workingMemory.activeEntities.values());
  }

  /**
   * Update conversation context
   */
  async updateContext(
    sessionId: string, 
    updates: Partial<ConversationContext>
  ): Promise<void> {
    const state = await this.getSession(sessionId);
    if (!state) {
      throw new PersonalizationError(
        'Session not found',
        'PROFILE_NOT_FOUND',
        { sessionId }
      );
    }

    state.context = { ...state.context, ...updates };
    await this.saveSession(state);
  }

  /**
   * End a conversation session
   */
  async endSession(sessionId: string): Promise<void> {
    const state = await this.getSession(sessionId);
    if (!state) {
      return;
    }

    state.status = 'ended';
    await this.saveSession(state);
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    const pattern = this.getSessionPattern();
    const keys = await this.redis.keys(pattern);
    
    let cleaned = 0;
    for (const key of keys) {
      const ttl = await this.redis.ttl(key);
      if (ttl === -2) { // Key doesn't exist
        cleaned++;
      }
    }
    
    return cleaned;
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<{
    totalSessions: number;
    activeSessions: number;
    totalMessages: number;
    avgMessagesPerSession: number;
  }> {
    const pattern = this.getSessionPattern();
    const keys = await this.redis.keys(pattern);
    
    let activeSessions = 0;
    let totalMessages = 0;
    
    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        const state = this.deserializeState(data);
        if (state.status === 'active') {
          activeSessions++;
        }
        totalMessages += state.workingMemory.recentMessages.length;
      }
    }
    
    return {
      totalSessions: keys.length,
      activeSessions,
      totalMessages,
      avgMessagesPerSession: keys.length > 0 ? totalMessages / keys.length : 0
    };
  }

  /**
   * Helper methods
   */
  private getSessionKey(sessionId: string): string {
    return `session:${sessionId}`;
  }

  private getUserSessionsKey(userId: string): string {
    return `user_sessions:${userId}`;
  }

  private getSessionPattern(): string {
    return 'session:*';
  }

  private serializeState(state: ConversationState): string {
    // Convert Map to Array for serialization
    const serializable = {
      ...state,
      workingMemory: {
        ...state.workingMemory,
        activeEntities: Array.from(state.workingMemory.activeEntities.entries())
      }
    };
    return JSON.stringify(serializable);
  }

  private deserializeState(data: string): ConversationState {
    const parsed = JSON.parse(data);
    
    // Convert Array back to Map
    return {
      ...parsed,
      startedAt: new Date(parsed.startedAt),
      lastMessageAt: new Date(parsed.lastMessageAt),
      workingMemory: {
        ...parsed.workingMemory,
        activeEntities: new Map(parsed.workingMemory.activeEntities)
      }
    };
  }

  private createEmptyContext(): ConversationContext {
    return {
      currentTopic: {
        topic: 'general',
        startedAt: new Date(),
        depth: 0,
        userEngagement: 0.5
      },
      topicHistory: [],
      emotionalJourney: [],
      unresolvedQuestions: [],
      keyPoints: [],
      goals: []
    };
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}