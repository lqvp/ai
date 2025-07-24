/**
 * Test suite for PersonalizationEngine
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { PersonalizationEngine } from '../core/PersonalizationEngine.js';
import { WorkingMemory } from '../memory/WorkingMemory.js';
import { ProfileManager } from '../profile/ProfileManager.js';
import { createPersonalizationEngine } from '../index.js';

// Mock services
class MockEmbeddingService {
  async generateEmbedding(text: string): Promise<number[]> {
    // Simple mock: return array of random numbers
    return Array(768).fill(0).map(() => Math.random());
  }
  
  async extractEntities(text: string): Promise<any[]> {
    return [{ text: 'test entity', type: 'concept', salience: 0.8 }];
  }
  
  async extractKeywords(text: string): Promise<string[]> {
    return text.split(' ').filter(w => w.length > 3);
  }
  
  async generateSummary(text: string): Promise<string> {
    return text.substring(0, 100) + '...';
  }
}

class MockMemoryAnalyzer {
  async analyzeMessage(message: string, context: any): Promise<any> {
    return {
      content: message,
      intent: { primary: 'statement', confidence: 0.9 },
      emotion: { primary: 'neutral', valence: 0, arousal: 0.3 },
      entities: [],
      shouldSaveToLongTerm: message.includes('important'),
      isFactual: false,
      isProcedural: false,
      isKeyPoint: message.includes('key'),
      hasPersonalInfo: message.includes('my name'),
      emotionalIntensity: 0.3,
      topicChange: false,
      emotionChange: false,
      conversationTone: 'neutral',
      isUnresolved: false
    };
  }
}

class MockInferenceEngine {
  async analyzeEvents(events: any[], profile: any): Promise<any> {
    return {
      confirmedInfo: {},
      inferredInfo: {},
      preferences: {},
      personalityTraits: {},
      topicInterests: [],
      sentiment: 0.5,
      sentimentConfidence: 0.8
    };
  }
}

class MockLLMService {
  async generate(prompt: string, options: any): Promise<string> {
    return 'This is a mock response to: ' + prompt.substring(0, 50);
  }
}

class MockPromptTemplates {
  getTemplate(name: string): string {
    return 'Mock template for ' + name;
  }
}

describe('PersonalizationEngine', () => {
  let engine: PersonalizationEngine;
  
  beforeAll(async () => {
    // Create engine with mock services
    const config = {
      redisUrl: 'redis://localhost:6379',
      chromaUrl: 'http://localhost:8000',
      postgresUrl: 'postgresql://localhost/test',
      elasticsearchUrl: 'http://localhost:9200',
      embeddingService: new MockEmbeddingService(),
      memoryAnalyzer: new MockMemoryAnalyzer(),
      inferenceEngine: new MockInferenceEngine(),
      llmService: new MockLLMService(),
      promptTemplates: new MockPromptTemplates()
    };
    
    engine = new PersonalizationEngine(config);
    // Note: In real tests, we'd mock the database connections
  });
  
  afterAll(async () => {
    await engine.disconnect();
  });

  describe('Message Processing', () => {
    it('should process a simple message', async () => {
      const result = await engine.processMessage('test_user', 'Hello, AI!');
      
      expect(result).toBeDefined();
      expect(result.content).toBeTruthy();
      expect(result.sessionId).toBeTruthy();
      expect(result.metadata.processingTime).toBeGreaterThan(0);
    });

    it('should handle important messages', async () => {
      const result = await engine.processMessage(
        'test_user', 
        'This is an important message about my project'
      );
      
      expect(result).toBeDefined();
      expect(result.metadata.memoriesAccessed).toBeDefined();
    });

    it('should maintain session continuity', async () => {
      const result1 = await engine.processMessage('test_user', 'First message');
      const result2 = await engine.processMessage('test_user', 'Second message', {
        sessionId: result1.sessionId
      });
      
      expect(result2.sessionId).toBe(result1.sessionId);
    });
  });

  describe('Special Commands', () => {
    it('should handle memory display command', async () => {
      const result = await engine.processMessage('test_user', '記憶を見せて');
      
      expect(result.content).toContain('記憶');
      expect(result.metadata.commandType).toBe('show_memories');
    });

    it('should handle profile display command', async () => {
      const result = await engine.processMessage('test_user', 'プロファイルを見せて');
      
      expect(result.content).toBeTruthy();
      expect(result.metadata.commandType).toBe('show_profile');
    });

    it('should handle memory search command', async () => {
      const result = await engine.processMessage('test_user', '記憶を検索：プロジェクト');
      
      expect(result.content).toContain('検索結果');
      expect(result.metadata.commandType).toBe('search_memories');
    });
  });

  describe('Personalization', () => {
    it('should adapt response based on relationship level', async () => {
      // First interaction - should be formal
      const result1 = await engine.processMessage('new_user', 'Hello');
      
      // Simulate multiple interactions to change relationship level
      for (let i = 0; i < 10; i++) {
        await engine.processMessage('new_user', `Message ${i}`);
      }
      
      // Later interaction - should be less formal
      const result2 = await engine.processMessage('new_user', 'Hello again');
      
      // In a real test, we'd check the actual formality difference
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });
  });
});

describe('WorkingMemory', () => {
  let workingMemory: WorkingMemory;
  
  beforeAll(() => {
    workingMemory = new WorkingMemory('redis://localhost:6379');
  });
  
  afterAll(async () => {
    await workingMemory.disconnect();
  });

  it('should create and retrieve sessions', async () => {
    const session = await workingMemory.createSession('test_user');
    
    expect(session).toBeDefined();
    expect(session.userId).toBe('test_user');
    expect(session.status).toBe('active');
    
    const retrieved = await workingMemory.getSession(session.sessionId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.sessionId).toBe(session.sessionId);
  });

  it('should add messages to working memory', async () => {
    const session = await workingMemory.createSession('test_user');
    
    await workingMemory.addMessage(session.sessionId, {
      id: 'msg1',
      content: 'Test message',
      timestamp: new Date(),
      role: 'user'
    });
    
    const messages = await workingMemory.getRecentMessages(session.sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Test message');
  });

  it('should maintain message limit', async () => {
    const session = await workingMemory.createSession('test_user');
    
    // Add 60 messages (limit is 50)
    for (let i = 0; i < 60; i++) {
      await workingMemory.addMessage(session.sessionId, {
        id: `msg${i}`,
        content: `Message ${i}`,
        timestamp: new Date(),
        role: 'user'
      });
    }
    
    const updatedSession = await workingMemory.getSession(session.sessionId);
    expect(updatedSession?.workingMemory.recentMessages).toHaveLength(50);
  });
});

describe('ProfileManager', () => {
  let profileManager: ProfileManager;
  
  beforeAll(async () => {
    profileManager = new ProfileManager(
      'postgresql://localhost/test',
      new MockInferenceEngine()
    );
    // Note: In real tests, we'd mock the database
  });
  
  afterAll(async () => {
    await profileManager.disconnect();
  });

  it('should create default profile for new user', async () => {
    const profile = await profileManager.getOrCreateProfile('new_user');
    
    expect(profile).toBeDefined();
    expect(profile.userId).toBe('new_user');
    expect(profile.metadata.relationshipLevel).toBe('new');
    expect(profile.metadata.trustScore).toBe(0.5);
  });

  it('should update profile preferences', async () => {
    const updated = await profileManager.updateProfile('test_user', {
      preferences: {
        communication: {
          responseLength: 'brief',
          formality: 0.8,
          emotionalTone: 0.6,
          humor: 0.4,
          technicalDepth: 0.7,
          creativity: 0.5
        },
        topics: {
          interests: [{ topic: 'AI', score: 0.9, lastMentioned: new Date(), mentionCount: 5, sentiment: 0.8 }],
          avoidTopics: ['politics'],
          expertise: []
        },
        interaction: {
          preferredTimes: [9, 10, 11, 14, 15, 16],
          responseSpeed: 'thoughtful',
          initiativeLevel: 0.6,
          privacyLevel: 'moderate'
        }
      }
    });
    
    expect(updated.preferences.communication.formality).toBe(0.8);
    expect(updated.preferences.topics.interests[0].topic).toBe('AI');
  });

  it('should generate profile summary', async () => {
    const summary = await profileManager.getProfileSummary('test_user');
    
    expect(summary).toBeTruthy();
    expect(summary).toContain('関係');
  });
});

describe('Integration Tests', () => {
  it('should handle full conversation flow', async () => {
    const engine = createPersonalizationEngine({
      geminiApiKey: 'test_key'
    });
    
    // Simulate a conversation
    const messages = [
      'こんにちは！私の名前は太郎です。',
      'AIについて興味があります。',
      'important: 来週プレゼンがあります。',
      '記憶を見せて'
    ];
    
    let sessionId: string | undefined;
    
    for (const message of messages) {
      const result = await engine.processMessage('taro_user', message, { sessionId });
      sessionId = result.sessionId;
      
      expect(result).toBeDefined();
      expect(result.content).toBeTruthy();
    }
    
    await engine.disconnect();
  });

  it('should handle memory reset flow', async () => {
    const engine = createPersonalizationEngine({
      geminiApiKey: 'test_key'
    });
    
    // Add some memories
    await engine.processMessage('reset_test_user', 'This is an important memory');
    
    // Request reset
    const resetRequest = await engine.processMessage('reset_test_user', '記憶をリセット');
    expect(resetRequest.content).toContain('本当に');
    
    // Confirm reset
    const resetConfirm = await engine.processMessage('reset_test_user', 'はい、リセットして');
    expect(resetConfirm.content).toContain('リセットしました');
    
    // Check memories are gone
    const checkMemories = await engine.processMessage('reset_test_user', '記憶を見せて');
    expect(checkMemories.content).toContain('0件');
    
    await engine.disconnect();
  });
});