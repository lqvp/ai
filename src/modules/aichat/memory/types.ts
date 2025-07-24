// Memory and Personalization Type Definitions

// 感情分析の結果
export interface EmotionAnalysis {
  sentiment: 'positive' | 'negative' | 'neutral';
  confidence: number;
  emotions: {
    joy: number;
    sadness: number;
    anger: number;
    fear: number;
    surprise: number;
    love: number;
  };
}

// トピック分析の結果
export interface TopicAnalysis {
  mainTopic: string;
  subTopics: string[];
  keywords: string[];
  entities: {
    people: string[];
    places: string[];
    organizations: string[];
    products: string[];
    events: string[];
  };
}

// 意図分類の結果
export interface IntentClassification {
  type: 'question' | 'statement' | 'request' | 'greeting' | 'farewell' | 'emotion' | 'other';
  confidence: number;
  subType?: string;
}

// 記憶判定の結果
export interface MemoryDecision {
  shouldSave: boolean;
  importance: number; // 0-1
  category: string;
  summary: string;
  tags: string[];
  expiresAt?: Date;
}

// パーソナライゼーション提案
export interface PersonalizationSuggestion {
  preferredStyle: {
    formality: number; // 0-1
    emotionalExpression: number; // 0-1
    humor: number; // 0-1
    technicalDepth: number; // 0-1
    creativity: number; // 0-1
  };
  adjustments: string[];
}

// 応答ガイダンス
export interface ResponseGuidance {
  tone: 'friendly' | 'professional' | 'casual' | 'empathetic' | 'humorous';
  length: 'brief' | 'moderate' | 'detailed';
  useEmoji: boolean;
  emphasisPoints: string[];
  avoidTopics: string[];
}

// 統合分析結果
export interface ConversationAnalysis {
  emotion: EmotionAnalysis;
  topic: TopicAnalysis;
  intent: IntentClassification;
  memory: MemoryDecision;
  personalization: PersonalizationSuggestion;
  guidance: ResponseGuidance;
  timestamp: Date;
}

// メモリーエントリ
export interface MemoryEntry {
  id: string;
  userId: string;
  content: string;
  summary: string;
  analysis: ConversationAnalysis;
  context: {
    previousMessages: string[];
    noteId?: string;
    isChat: boolean;
  };
  metadata: {
    createdAt: Date;
    updatedAt: Date;
    accessCount: number;
    lastAccessedAt: Date;
    importance: number;
    category: string;
    tags: string[];
    embedding?: number[];
  };
}

// ユーザープロファイル
export interface UserProfile {
  userId: string;
  personality: {
    openness: number; // 0-1
    conscientiousness: number; // 0-1
    extraversion: number; // 0-1
    agreeableness: number; // 0-1
    neuroticism: number; // 0-1
  };
  preferences: {
    responseLength: 'brief' | 'moderate' | 'detailed' | 'adaptive';
    formality: number; // 0-1
    emotionalExpression: number; // 0-1
    humor: number; // 0-1
    technicalDepth: number; // 0-1
    creativity: number; // 0-1
  };
  interests: {
    topic: string;
    score: number;
    lastMentioned: Date;
  }[];
  communicationStyle: {
    preferredGreeting: string;
    preferredFarewell: string;
    emojiUsage: 'never' | 'rarely' | 'sometimes' | 'often' | 'always';
    responseTime: 'immediate' | 'thoughtful' | 'delayed';
  };
  statistics: {
    totalInteractions: number;
    averageMessageLength: number;
    mostActiveHours: number[];
    sentimentHistory: {
      date: Date;
      sentiment: 'positive' | 'negative' | 'neutral';
    }[];
  };
  updatedAt: Date;
}

// 会話状態
export interface ConversationState {
  userId: string;
  currentTopic: string;
  topicHistory: {
    topic: string;
    startedAt: Date;
    endedAt?: Date;
  }[];
  emotionalJourney: {
    timestamp: Date;
    emotion: EmotionAnalysis;
  }[];
  unresolvedQuestions: {
    question: string;
    askedAt: Date;
    context: string;
  }[];
  keyPoints: string[];
  lastInteraction: Date;
}

// メモリー検索クエリ
export interface MemorySearchQuery {
  userId: string;
  query?: string;
  category?: string;
  tags?: string[];
  dateRange?: {
    start: Date;
    end: Date;
  };
  minImportance?: number;
  limit?: number;
  includeEmbeddings?: boolean;
}

// メモリー検索結果
export interface MemorySearchResult {
  entries: MemoryEntry[];
  relevanceScores: number[];
  totalCount: number;
  categories: string[];
  commonTags: string[];
}