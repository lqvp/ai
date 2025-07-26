import loki from 'lokijs';
import PersonalizationEngine from '../src/personalization/PersonalizationEngine.js';
import { 
  MemoryType, 
  RelationshipLevel,
  CommunicationStyle 
} from '../src/personalization/types.js';

describe('Personalization System Tests', () => {
  let db: loki;
  let engine: PersonalizationEngine;
  const testUserId = 'test-user-123';
  let sessionId: string;

  beforeEach(() => {
    // Create in-memory database
    db = new loki('test.db');
    engine = new PersonalizationEngine(db);
  });

  afterEach(() => {
    engine.shutdown();
  });

  describe('User Profile Management', () => {
    test('should create new user profile on first interaction', async () => {
      const result = await engine.processMessage(
        testUserId,
        'Hello, my name is Alice!'
      );
      
      expect(result.personalizedPrompt).toBeDefined();
      
      const stats = await engine.getStats(testUserId);
      expect(stats.profile.relationshipLevel).toBe(RelationshipLevel.NEW_USER);
      expect(stats.profile.totalInteractions).toBe(1);
    });

    test('should extract and store explicit information', async () => {
      await engine.processMessage(
        testUserId,
        'Hi, my name is Bob and I work as a software engineer.'
      );
      
      const stats = await engine.getStats(testUserId);
      expect(stats.profile.dataQuality).not.toBe('low');
    });

    test('should infer communication style', async () => {
      // Formal style
      await engine.processMessage(
        testUserId,
        'Good morning. Could you please help me with this task? I would appreciate your assistance.'
      );
      
      // Technical style
      await engine.processMessage(
        testUserId,
        'I need to implement an API endpoint that handles database transactions.'
      );
      
      const result = await engine.processMessage(
        testUserId,
        'How does the algorithm work?'
      );
      
      expect(result.personalizedPrompt?.styleGuidance).toContain('technical');
    });
  });

  describe('Memory System', () => {
    beforeEach(async () => {
      sessionId = await engine.createSession(testUserId);
    });

    test('should store important facts as semantic memories', async () => {
      await engine.processMessage(
        testUserId,
        'I love playing guitar and I have a cat named Whiskers.',
        sessionId
      );
      
      await engine.processResponse(
        testUserId,
        sessionId,
        'I love playing guitar and I have a cat named Whiskers.',
        'That\'s wonderful! Playing guitar is a great hobby.'
      );
      
      const stats = await engine.getStats(testUserId);
      expect(stats.memoryStats.byType[MemoryType.SEMANTIC]).toBeGreaterThan(0);
    });

    test('should retrieve relevant memories for context', async () => {
      // Store some memories
      await engine.processMessage(
        testUserId,
        'I work on machine learning projects.',
        sessionId
      );
      
      await engine.processMessage(
        testUserId,
        'My favorite programming language is Python.',
        sessionId
      );
      
      // Query about related topic
      const result = await engine.processMessage(
        testUserId,
        'Can you help me with a Python ML problem?',
        sessionId
      );
      
      expect(result.personalizedPrompt?.relevantMemories.length).toBeGreaterThan(0);
      expect(result.personalizedPrompt?.userContext).toContain('machine learning');
    });
  });

  describe('User Commands', () => {
    test('should handle /profile command', async () => {
      // Create some history
      await engine.processMessage(testUserId, 'My name is Charlie');
      await engine.processMessage(testUserId, 'I enjoy reading books');
      
      const result = await engine.processMessage(testUserId, '/profile');
      
      expect(result.commandResult?.success).toBe(true);
      expect(result.commandResult?.message).toContain('Your Profile');
      expect(result.commandResult?.message).toContain('Charlie');
    });

    test('should handle /memories command', async () => {
      sessionId = await engine.createSession(testUserId);
      
      // Create some memories
      await engine.processMessage(
        testUserId,
        'I graduated from MIT last year.',
        sessionId
      );
      
      const result = await engine.processMessage(testUserId, '/memories');
      
      expect(result.commandResult?.success).toBe(true);
      expect(result.commandResult?.message).toContain('Your Memories');
    });

    test('should handle /forget command', async () => {
      sessionId = await engine.createSession(testUserId);
      
      // Store a memory
      await engine.processMessage(
        testUserId,
        'My secret password is 12345.',
        sessionId
      );
      
      // Forget it
      const result = await engine.processMessage(
        testUserId,
        '/forget password'
      );
      
      expect(result.commandResult?.success).toBe(true);
      expect(result.commandResult?.message).toContain('Successfully forgot');
    });

    test('should handle /update_info command', async () => {
      const result = await engine.processMessage(
        testUserId,
        '/update_info name=David interests=music,art location=Tokyo'
      );
      
      expect(result.commandResult?.success).toBe(true);
      expect(result.commandResult?.message).toContain('Successfully updated');
      
      // Verify update
      const profileResult = await engine.processMessage(testUserId, '/profile');
      expect(profileResult.commandResult?.message).toContain('David');
      expect(profileResult.commandResult?.message).toContain('music, art');
      expect(profileResult.commandResult?.message).toContain('Tokyo');
    });

    test('should handle /help command', async () => {
      const result = await engine.processMessage(testUserId, '/help');
      
      expect(result.commandResult?.success).toBe(true);
      expect(result.commandResult?.message).toContain('Memory Management Commands');
    });
  });

  describe('Relationship Evolution', () => {
    test('should upgrade relationship level with interactions', async () => {
      sessionId = await engine.createSession(testUserId);
      
      // Initial state
      let stats = await engine.getStats(testUserId);
      expect(stats.profile.relationshipLevel).toBe(RelationshipLevel.NEW_USER);
      
      // Simulate multiple interactions
      for (let i = 0; i < 6; i++) {
        await engine.processMessage(
          testUserId,
          `This is interaction number ${i + 1}`,
          sessionId
        );
      }
      
      stats = await engine.getStats(testUserId);
      expect(stats.profile.relationshipLevel).toBe(RelationshipLevel.ACQUAINTANCE);
    });
  });

  describe('Personalized Prompts', () => {
    test('should generate different prompts based on relationship level', async () => {
      sessionId = await engine.createSession(testUserId);
      
      // New user
      let result = await engine.processMessage(
        testUserId,
        'What can you do?',
        sessionId
      );
      
      expect(result.personalizedPrompt?.relationshipContext).toContain('new user');
      
      // Simulate many interactions
      for (let i = 0; i < 25; i++) {
        await engine.processMessage(testUserId, `Message ${i}`, sessionId);
      }
      
      // Familiar user
      result = await engine.processMessage(
        testUserId,
        'What can you do?',
        sessionId
      );
      
      expect(result.personalizedPrompt?.relationshipContext).toContain('familiar');
    });

    test('should include relevant past information in prompts', async () => {
      sessionId = await engine.createSession(testUserId);
      
      // Store project information
      await engine.processMessage(
        testUserId,
        'I am working on a project called QuantumAI.',
        sessionId
      );
      
      await engine.processMessage(
        testUserId,
        'The QuantumAI project uses neural networks.',
        sessionId
      );
      
      // Ask about the project
      const result = await engine.processMessage(
        testUserId,
        'Can you help me with my quantum project?',
        sessionId
      );
      
      expect(result.personalizedPrompt?.relevantMemories.some(
        m => m.content.includes('QuantumAI')
      )).toBe(true);
    });
  });
});