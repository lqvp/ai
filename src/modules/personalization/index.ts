/**
 * Personalization Module - Main export and integration interface
 */

export * from './types/index.js';
export * from './core/PersonalizationEngine.js';
export * from './memory/MemoryEngine.js';
export * from './memory/WorkingMemory.js';
export * from './memory/LongTermMemory.js';
export * from './profile/ProfileManager.js';

import { PersonalizationEngine, PersonalizationConfig } from './core/PersonalizationEngine.js';
import { GeminiEmbeddingService } from './services/GeminiEmbeddingService.js';
import { GeminiMemoryAnalyzer } from './services/GeminiMemoryAnalyzer.js';
import { GeminiInferenceEngine } from './services/GeminiInferenceEngine.js';
import { GeminiLLMService } from './services/GeminiLLMService.js';
import { DefaultPromptTemplates } from './utils/PromptTemplates.js';

/**
 * Factory function to create a configured PersonalizationEngine
 */
export function createPersonalizationEngine(config: {
  redisUrl?: string;
  chromaUrl?: string;
  postgresUrl?: string;
  elasticsearchUrl?: string;
  geminiApiKey: string;
  geminiModel?: string;
}): PersonalizationEngine {
  // Set defaults
  const redisUrl = config.redisUrl || 'redis://localhost:6379';
  const chromaUrl = config.chromaUrl || 'http://localhost:8000';
  const postgresUrl = config.postgresUrl || 'postgresql://localhost/aichat';
  const elasticsearchUrl = config.elasticsearchUrl || 'http://localhost:9200';
  const geminiModel = config.geminiModel || 'gemini-pro';

  // Create service instances
  const embeddingService = new GeminiEmbeddingService(config.geminiApiKey, geminiModel);
  const memoryAnalyzer = new GeminiMemoryAnalyzer(config.geminiApiKey, geminiModel);
  const inferenceEngine = new GeminiInferenceEngine(config.geminiApiKey, geminiModel);
  const llmService = new GeminiLLMService(config.geminiApiKey, geminiModel);
  const promptTemplates = new DefaultPromptTemplates();

  // Create engine configuration
  const engineConfig: PersonalizationConfig = {
    redisUrl,
    chromaUrl,
    postgresUrl,
    elasticsearchUrl,
    embeddingService,
    memoryAnalyzer,
    inferenceEngine,
    llmService,
    promptTemplates
  };

  return new PersonalizationEngine(engineConfig);
}

/**
 * Integration adapter for existing AI chat module
 */
export class PersonalizationAdapter {
  private engine: PersonalizationEngine;
  private initialized: boolean = false;

  constructor(engine: PersonalizationEngine) {
    this.engine = engine;
  }

  /**
   * Initialize the personalization system
   */
  async initialize(): Promise<void> {
    if (!this.initialized) {
      await this.engine.initialize();
      this.initialized = true;
    }
  }

  /**
   * Process a message with personalization
   */
  async processMessage(
    userId: string,
    message: string,
    context?: {
      noteId?: string;
      isChat?: boolean;
      fromMention?: boolean;
    }
  ): Promise<{
    response: string;
    sessionId: string;
    shouldSave?: boolean;
  }> {
    await this.initialize();

    const result = await this.engine.processMessage(userId, message, {
      noteId: context?.noteId,
      isChat: context?.isChat,
      metadata: { fromMention: context?.fromMention }
    });

    return {
      response: result.content,
      sessionId: result.sessionId,
      shouldSave: result.metadata.memoriesAccessed && result.metadata.memoriesAccessed > 0
    };
  }

  /**
   * Get user memory summary
   */
  async getMemorySummary(userId: string): Promise<string> {
    await this.initialize();
    
    const insights = await this.engine.getUserInsights(userId);
    const profile = await this.engine.profileManager.getProfileSummary(userId);
    
    return `${profile}\n\n最近の洞察:\n${insights.insights.map(i => `- ${i.title}`).join('\n')}`;
  }

  /**
   * Handle memory commands
   */
  async handleMemoryCommand(
    userId: string,
    command: string
  ): Promise<string | null> {
    await this.initialize();

    const commandMap: Record<string, () => Promise<string>> = {
      'show_memory': async () => {
        const result = await this.engine.processMessage(userId, '記憶を見せて');
        return result.content;
      },
      'show_profile': async () => {
        const result = await this.engine.processMessage(userId, 'プロファイルを見せて');
        return result.content;
      },
      'reset_memory': async () => {
        const result = await this.engine.processMessage(userId, '記憶をリセット');
        return result.content;
      }
    };

    const handler = commandMap[command];
    return handler ? await handler() : null;
  }

  /**
   * Run maintenance tasks
   */
  async runMaintenance(): Promise<void> {
    await this.initialize();
    await this.engine.runMaintenance();
  }

  /**
   * Cleanup
   */
  async disconnect(): Promise<void> {
    if (this.initialized) {
      await this.engine.disconnect();
    }
  }
}

/**
 * Default configuration for quick setup
 */
export const defaultPersonalizationConfig = {
  memory: {
    maxEntriesPerUser: 1000,
    consolidationThreshold: 100,
    decayRate: 0.01,
    embeddingDimensions: 768
  },
  profile: {
    updateInterval: 300000, // 5 minutes
    inferenceConfidenceThreshold: 0.7,
    relationshipProgressionThresholds: {
      familiar: 10,
      friend: 30,
      collaborator: 100
    }
  },
  conversation: {
    contextWindowSize: 50,
    workingMemoryDuration: 86400000, // 24 hours
    topicSimilarityThreshold: 0.8,
    emotionDetectionSensitivity: 0.6
  },
  analytics: {
    eventRetentionDays: 90,
    insightGenerationInterval: 3600000, // 1 hour
    minimumDataPoints: 10
  }
};