/**
 * AIチャットパーソナライゼーションシステムの型定義
 */

// ユーザープロファイル型
export interface UserProfile {
  userId: string;
  createdAt: number;
  updatedAt: number;
  
  // 明示的情報
  explicit: {
    name?: string;
    age?: number;
    location?: string;
    occupation?: string;
    interests: string[];
    goals: string[];
    preferences: Record<string, any>;
  };
  
  // 推論された情報
  implicit: {
    communicationStyle?: CommunicationStyle;
    expertise: string[];
    values: string[];
    personality: PersonalityTraits;
    patterns: BehaviorPattern[];
  };
  
  // 関係性の追跡
  relationship: {
    level: RelationshipLevel;
    firstInteraction: number;
    totalInteractions: number;
    lastInteraction: number;
    trustScore: number; // 0-1
  };
  
  // メタ情報
  meta: {
    version: number;
    lastAnalyzed: number;
    dataQuality: DataQuality;
  };
}

export enum RelationshipLevel {
  NEW_USER = 'new_user',
  ACQUAINTANCE = 'acquaintance',
  FAMILIAR = 'familiar',
  FRIEND = 'friend',
  COLLABORATOR = 'collaborator'
}

export enum CommunicationStyle {
  FORMAL = 'formal',
  CASUAL = 'casual',
  TECHNICAL = 'technical',
  CREATIVE = 'creative',
  ANALYTICAL = 'analytical'
}

export interface PersonalityTraits {
  openness: number; // 0-1
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

export interface BehaviorPattern {
  type: string;
  frequency: number;
  lastOccurrence: number;
  confidence: number; // 0-1
}

export enum DataQuality {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high'
}

// 記憶型
export interface Memory {
  id: string;
  userId: string;
  timestamp: number;
  type: MemoryType;
  content: string;
  importance: number; // 0-1
  accessCount: number;
  lastAccessed: number;
  decay: number; // 0-1、1は減衰なし
  metadata: MemoryMetadata;
}

export enum MemoryType {
  EPISODIC = 'episodic',
  SEMANTIC = 'semantic',
  PROCEDURAL = 'procedural',
  WORKING = 'working'
}

export interface MemoryMetadata {
  entities: string[];
  emotions?: EmotionData;
  context?: string;
  source: MemorySource;
  confidence: number; // 0-1
  tags: string[];
}

export interface EmotionData {
  primary: string;
  intensity: number; // 0-1
  valence: number; // -1 to 1
}

export enum MemorySource {
  DIRECT_STATEMENT = 'direct_statement',
  INFERRED = 'inferred',
  OBSERVED = 'observed',
  SYSTEM = 'system'
}

// 短期記憶
export interface ShortTermMemory {
  sessionId: string;
  userId: string;
  startTime: number;
  lastUpdate: number;
  context: ConversationContext;
  workingMemory: WorkingMemoryItem[];
  attention: AttentionFocus;
}

export interface ConversationContext {
  topic: string;
  mood: string;
  intent: string;
  entities: Entity[];
  previousTopics: string[];
}

export interface WorkingMemoryItem {
  content: string;
  timestamp: number;
  relevance: number; // 0-1
  type: 'user_input' | 'ai_response' | 'context';
}

export interface AttentionFocus {
  primary: string;
  secondary: string[];
  weights: Record<string, number>;
}

export interface Entity {
  text: string;
  type: EntityType;
  confidence: number;
  metadata?: Record<string, any>;
}

export enum EntityType {
  PERSON = 'person',
  LOCATION = 'location',
  ORGANIZATION = 'organization',
  DATE = 'date',
  EVENT = 'event',
  PRODUCT = 'product',
  CONCEPT = 'concept',
  OTHER = 'other'
}

// ナレッジグラフ型
export interface KnowledgeNode {
  id: string;
  userId: string;
  type: NodeType;
  label: string;
  properties: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  confidence: number;
}

export interface KnowledgeEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relationship: string;
  properties: Record<string, any>;
  weight: number;
  createdAt: number;
}

export enum NodeType {
  PERSON = 'person',
  PLACE = 'place',
  THING = 'thing',
  CONCEPT = 'concept',
  EVENT = 'event',
  PREFERENCE = 'preference',
  SKILL = 'skill'
}

// ベクトル埋め込み型
export interface VectorMemory {
  id: string;
  userId: string;
  content: string;
  embedding: number[];
  metadata: VectorMetadata;
  timestamp: number;
}

export interface VectorMetadata {
  memoryId: string;
  type: MemoryType;
  importance: number;
  tags: string[];
}

// ユーザー制御型
export interface MemoryQuery {
  userId: string;
  filters?: {
    type?: MemoryType[];
    dateRange?: { start: number; end: number };
    importance?: { min: number; max: number };
    tags?: string[];
    search?: string;
  };
  limit?: number;
  offset?: number;
}

export interface MemoryUpdate {
  memoryId: string;
  userId: string;
  updates: {
    content?: string;
    importance?: number;
    tags?: string[];
    metadata?: Partial<MemoryMetadata>;
  };
}

export interface PrivacySettings {
  userId: string;
  allowInference: boolean;
  allowLongTermStorage: boolean;
  dataRetentionDays: number;
  sensitiveTopics: string[];
  autoDeletePatterns: string[];
}

// 応答生成型
export interface PersonalizedPrompt {
  systemPrompt: string;
  userContext: string;
  relevantMemories: Memory[];
  relationshipContext: string;
  styleGuidance: string;
}

export interface ResponseContext {
  userId: string;
  message: string;
  shortTermContext: ShortTermMemory;
  longTermContext: Memory[];
  userProfile: UserProfile;
  privacySettings: PrivacySettings;
}

// 分析型
export interface UserAnalytics {
  userId: string;
  metrics: {
    totalInteractions: number;
    averageSessionLength: number;
    topTopics: { topic: string; count: number }[];
    satisfactionScore: number;
    engagementScore: number;
  };
  patterns: {
    activeHours: number[];
    preferredTopics: string[];
    communicationPatterns: Record<string, number>;
  };
}

// エラー型
export class PersonalizationError extends Error {
  constructor(
    message: string,
    public code: PersonalizationErrorCode,
    public details?: any
  ) {
    super(message);
    this.name = 'PersonalizationError';
  }
}

export enum PersonalizationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  MEMORY_NOT_FOUND = 'MEMORY_NOT_FOUND',
  INVALID_INPUT = 'INVALID_INPUT',
  STORAGE_ERROR = 'STORAGE_ERROR',
  VECTOR_DB_ERROR = 'VECTOR_DB_ERROR',
  PRIVACY_VIOLATION = 'PRIVACY_VIOLATION',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED'
}