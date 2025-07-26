import { bindThis } from '@/decorators.js';
import {
  Memory,
  ShortTermMemory,
  UserProfile,
  Entity,
  EntityType,
  PersonalizedPrompt,
  ResponseContext
} from './types.js';
import HybridMemorySystem from './HybridMemorySystem.js';
import UserProfileManager from './UserProfileManager.js';

/**
 * Context Engine
 * Intelligently retrieves and manages context for personalized responses
 */
export default class ContextEngine {
  private readonly MAX_CONTEXT_MEMORIES = 10;
  private readonly CONTEXT_WINDOW_SIZE = 4000; // Characters
  private readonly RELEVANCE_THRESHOLD = 0.3;

  constructor(
    private memorySystem: HybridMemorySystem,
    private profileManager: UserProfileManager
  ) {}

  /**
   * Build complete response context
   */
  @bindThis
  public async buildResponseContext(
    userId: string,
    message: string,
    sessionId: string
  ): Promise<ResponseContext> {
    // Get user profile
    const userProfile = await this.profileManager.getOrCreateProfile(userId);
    
    // Get short-term memory
    const shortTermContext = await this.memorySystem.getOrCreateSession(userId, sessionId);
    
    // Extract entities from message
    const entities = this.extractEntities(message);
    
    // Update short-term memory with current message
    await this.memorySystem.updateShortTermMemory(
      sessionId,
      {
        content: message,
        timestamp: Date.now(),
        relevance: 1.0,
        type: 'user_input'
      },
      {
        entities,
        topic: this.inferTopic(message, entities),
        intent: this.inferIntent(message)
      }
    );
    
    // Retrieve relevant long-term memories
    const longTermContext = await this.memorySystem.retrieveRelevantMemories(
      userId,
      message,
      this.MAX_CONTEXT_MEMORIES
    );
    
    // Build response context
    return {
      userId,
      message,
      shortTermContext,
      longTermContext,
      userProfile,
      privacySettings: {
        userId,
        allowInference: true,
        allowLongTermStorage: true,
        dataRetentionDays: 365,
        sensitiveTopics: [],
        autoDeletePatterns: []
      }
    };
  }

  /**
   * Generate personalized prompt for LLM
   */
  @bindThis
  public async generatePersonalizedPrompt(
    context: ResponseContext
  ): Promise<PersonalizedPrompt> {
    const { userProfile, shortTermContext, longTermContext, message } = context;
    
    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(userProfile);
    
    // Build user context
    const userContext = this.buildUserContext(userProfile, shortTermContext);
    
    // Select most relevant memories
    const relevantMemories = this.selectRelevantMemories(
      longTermContext,
      message,
      shortTermContext
    );
    
    // Get relationship context
    const relationshipContext = this.profileManager.getRelationshipContext(userProfile);
    
    // Get style guidance
    const styleGuidance = this.profileManager.getStyleGuidance(userProfile);
    
    return {
      systemPrompt,
      userContext,
      relevantMemories,
      relationshipContext,
      styleGuidance
    };
  }

  /**
   * Extract information from AI response for memory storage
   */
  @bindThis
  public async processResponse(
    userId: string,
    sessionId: string,
    aiResponse: string,
    userMessage: string
  ): Promise<void> {
    // Update short-term memory with AI response
    await this.memorySystem.updateShortTermMemory(
      sessionId,
      {
        content: aiResponse,
        timestamp: Date.now(),
        relevance: 0.8,
        type: 'ai_response'
      }
    );
    
    // Extract any new information about the user
    const extractedInfo = this.extractUserInfo(userMessage, aiResponse);
    
    if (extractedInfo.explicit) {
      await this.profileManager.addExplicitInfo(userId, extractedInfo.explicit);
    }
    
    if (extractedInfo.implicit) {
      await this.profileManager.inferImplicitInfo(userId, {
        message: userMessage,
        context: aiResponse,
        entities: this.extractEntities(userMessage).map(e => e.text)
      });
    }
    
    // Determine if this interaction should be consolidated to long-term memory
    const shouldConsolidate = await this.shouldConsolidateMemory(sessionId);
    
    if (shouldConsolidate) {
      await this.memorySystem.consolidateMemories(sessionId, userId);
    }
  }

  /**
   * Calculate context relevance score
   */
  @bindThis
  public calculateRelevance(
    memory: Memory,
    currentContext: ShortTermMemory,
    query: string
  ): number {
    let score = 0;
    
    // Recency factor
    const daysSinceMemory = (Date.now() - memory.timestamp) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.exp(-daysSinceMemory / 30); // Exponential decay over 30 days
    score += recencyScore * 0.2;
    
    // Topic similarity
    const memoryTopics = memory.metadata.tags;
    const currentTopic = currentContext.context.topic;
    if (memoryTopics.includes(currentTopic)) {
      score += 0.3;
    }
    
    // Entity overlap
    const memoryEntities = new Set(memory.metadata.entities);
    const currentEntities = new Set(currentContext.context.entities.map(e => e.text));
    const entityOverlap = [...memoryEntities].filter(e => currentEntities.has(e)).length;
    score += (entityOverlap / Math.max(memoryEntities.size, 1)) * 0.3;
    
    // Keyword matching
    const keywords = this.extractKeywords(query);
    const keywordMatches = keywords.filter(k => 
      memory.content.toLowerCase().includes(k.toLowerCase())
    ).length;
    score += (keywordMatches / Math.max(keywords.length, 1)) * 0.2;
    
    // Apply memory importance and decay
    score *= memory.importance * memory.decay;
    
    return Math.min(1, score);
  }

  // Private helper methods

  private buildSystemPrompt(profile: UserProfile): string {
    const traits = profile.implicit.personality;
    const expertise = profile.implicit.expertise;
    
    let prompt = "You are a helpful AI assistant with deep personalization capabilities. ";
    
    // Add personality understanding
    if (traits.openness > 0.7) {
      prompt += "The user appreciates creative and novel ideas. ";
    }
    if (traits.conscientiousness > 0.7) {
      prompt += "The user values detailed, well-organized responses. ";
    }
    
    // Add expertise context
    if (expertise.length > 0) {
      prompt += `The user has expertise in: ${expertise.join(', ')}. `;
    }
    
    // Add communication preferences
    if (profile.explicit.preferences.responseLength) {
      prompt += `Prefer ${profile.explicit.preferences.responseLength} responses. `;
    }
    
    return prompt;
  }

  private buildUserContext(
    profile: UserProfile,
    shortTerm: ShortTermMemory
  ): string {
    const parts: string[] = [];
    
    // Add user identification
    if (profile.explicit.name) {
      parts.push(`User's name: ${profile.explicit.name}`);
    }
    
    // Add current conversation context
    if (shortTerm.context.topic) {
      parts.push(`Current topic: ${shortTerm.context.topic}`);
    }
    
    // Add recent context from working memory
    const recentInputs = shortTerm.workingMemory
      .filter(item => item.type === 'user_input')
      .slice(-3)
      .map(item => item.content);
    
    if (recentInputs.length > 0) {
      parts.push(`Recent conversation: ${recentInputs.join(' | ')}`);
    }
    
    // Add user interests and goals
    if (profile.explicit.interests.length > 0) {
      parts.push(`Interests: ${profile.explicit.interests.join(', ')}`);
    }
    
    if (profile.explicit.goals.length > 0) {
      parts.push(`Goals: ${profile.explicit.goals.join(', ')}`);
    }
    
    return parts.join('\n');
  }

  private selectRelevantMemories(
    memories: Memory[],
    query: string,
    shortTerm: ShortTermMemory
  ): Memory[] {
    // Calculate relevance scores
    const scoredMemories = memories.map(memory => ({
      memory,
      score: this.calculateRelevance(memory, shortTerm, query)
    }));
    
    // Sort by relevance
    scoredMemories.sort((a, b) => b.score - a.score);
    
    // Select memories that fit within context window
    const selected: Memory[] = [];
    let totalLength = 0;
    
    for (const { memory, score } of scoredMemories) {
      if (score < this.RELEVANCE_THRESHOLD) break;
      
      const memoryLength = memory.content.length;
      if (totalLength + memoryLength > this.CONTEXT_WINDOW_SIZE) break;
      
      selected.push(memory);
      totalLength += memoryLength;
    }
    
    return selected;
  }

  private extractEntities(text: string): Entity[] {
    const entities: Entity[] = [];
    
    // Simple regex-based entity extraction
    // In production, use NLP library or API
    
    // Extract names (capitalized words)
    const namePattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
    const names = text.match(namePattern) || [];
    names.forEach(name => {
      entities.push({
        text: name,
        type: EntityType.PERSON,
        confidence: 0.7
      });
    });
    
    // Extract dates
    const datePattern = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:, \d{4})?\b/gi;
    const dates = text.match(datePattern) || [];
    dates.forEach(date => {
      entities.push({
        text: date,
        type: EntityType.DATE,
        confidence: 0.9
      });
    });
    
    // Extract organizations (simple heuristic)
    const orgPattern = /\b(?:Inc|Corp|LLC|Ltd|Company|Corporation)\b/gi;
    const orgs = text.match(new RegExp(`\\b[A-Z][\\w\\s]+(?:${orgPattern.source})`, 'gi')) || [];
    orgs.forEach(org => {
      entities.push({
        text: org,
        type: EntityType.ORGANIZATION,
        confidence: 0.6
      });
    });
    
    return entities;
  }

  private inferTopic(message: string, entities: Entity[]): string {
    // Simple topic inference
    // In production, use topic modeling or classification
    
    const keywords = this.extractKeywords(message);
    
    // Check for common topics
    const topicPatterns = {
      'technology': /\b(computer|software|code|programming|tech|AI|machine learning)\b/i,
      'work': /\b(job|work|career|office|meeting|project|deadline)\b/i,
      'personal': /\b(family|friend|home|life|feel|emotion)\b/i,
      'learning': /\b(learn|study|course|education|teach|understand)\b/i,
      'entertainment': /\b(movie|music|game|book|show|watch|play)\b/i,
      'health': /\b(health|doctor|medicine|exercise|diet|sleep)\b/i,
      'travel': /\b(travel|trip|vacation|visit|fly|hotel)\b/i
    };
    
    for (const [topic, pattern] of Object.entries(topicPatterns)) {
      if (pattern.test(message)) {
        return topic;
      }
    }
    
    // Default to first keyword if no pattern matches
    return keywords[0] || 'general';
  }

  private inferIntent(message: string): string {
    // Simple intent classification
    // In production, use intent classification model
    
    const intents = {
      'question': /^(what|who|where|when|why|how|is|are|can|could|would|should)\b/i,
      'request': /\b(please|could you|can you|would you|help|need|want)\b/i,
      'statement': /\b(I am|I have|I think|I believe|I feel)\b/i,
      'greeting': /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i,
      'farewell': /\b(bye|goodbye|see you|talk later|good night)\b/i,
      'appreciation': /\b(thank|thanks|appreciate|grateful)\b/i,
      'complaint': /\b(problem|issue|wrong|broken|doesn't work|frustrated)\b/i
    };
    
    for (const [intent, pattern] of Object.entries(intents)) {
      if (pattern.test(message)) {
        return intent;
      }
    }
    
    return 'statement';
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been'
    ]);
    
    return text
      .toLowerCase()
      .split(/\W+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 10);
  }

  private extractUserInfo(userMessage: string, aiResponse: string): {
    explicit?: Partial<UserProfile['explicit']>;
    implicit?: boolean;
  } {
    const info: {
      explicit?: Partial<UserProfile['explicit']>;
      implicit?: boolean;
    } = {};
    
    // Extract explicit information from user message
    const nameMatch = userMessage.match(/(?:my name is|i'm|i am) ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
    if (nameMatch) {
      info.explicit = { name: nameMatch[1] };
    }
    
    const ageMatch = userMessage.match(/(?:i'm|i am) (\d+) years old/i);
    if (ageMatch) {
      info.explicit = { ...info.explicit, age: parseInt(ageMatch[1]) };
    }
    
    const interestMatch = userMessage.match(/(?:i like|i love|i enjoy|interested in) ([^.!?]+)/i);
    if (interestMatch) {
      const interest = interestMatch[1].trim();
      info.explicit = { 
        ...info.explicit, 
        interests: [interest]
      };
    }
    
    // Mark for implicit analysis if patterns detected
    if (/\b(think|feel|believe|prefer|usually|always|never)\b/i.test(userMessage)) {
      info.implicit = true;
    }
    
    return info;
  }

  private async shouldConsolidateMemory(sessionId: string): Promise<boolean> {
    // Consolidate based on various factors
    // This is a simplified version
    
    const session = await this.memorySystem.getOrCreateSession('', sessionId);
    
    // Consolidate if session has enough interactions
    if (session.workingMemory.length >= 8) {
      return true;
    }
    
    // Consolidate if significant time has passed
    const sessionDuration = Date.now() - session.startTime;
    if (sessionDuration > 20 * 60 * 1000) { // 20 minutes
      return true;
    }
    
    // Consolidate if topic changed significantly
    if (session.context.previousTopics.length >= 3) {
      return true;
    }
    
    return false;
  }
}