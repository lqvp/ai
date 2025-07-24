/**
 * Core type definitions for the AI Chat Personalization System
 */

// User Profile Types
export interface UserProfile {
  userId: string;
  metadata: ProfileMetadata;
  identity: UserIdentity;
  preferences: UserPreferences;
  personality: PersonalityProfile;
  statistics: UserStatistics;
}

export interface ProfileMetadata {
  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date;
  relationshipLevel: RelationshipLevel;
  trustScore: number; // 0-1
  version: number;
}

export type RelationshipLevel = 'new' | 'familiar' | 'friend' | 'collaborator';

export interface UserIdentity {
  confirmedInfo: ConfirmedInfo;
  inferredInfo: InferredInfo;
}

export interface ConfirmedInfo {
  name?: string;
  occupation?: string;
  location?: string;
  [key: string]: any;
}

export interface InferredInfo {
  [key: string]: InferredDataPoint;
}

export interface InferredDataPoint {
  value: any;
  confidence: number; // 0-1
  source: string; // conversation ID
  timestamp: Date;
  confirmationStatus: 'unconfirmed' | 'implicit' | 'explicit';
}

export interface UserPreferences {
  communication: CommunicationPreferences;
  topics: TopicPreferences;
  interaction: InteractionPreferences;
}

export interface CommunicationPreferences {
  responseLength: 'brief' | 'moderate' | 'detailed' | 'adaptive';
  formality: number; // 0-1
  emotionalTone: number; // 0-1
  humor: number; // 0-1
  technicalDepth: number; // 0-1
  creativity: number; // 0-1
  preferredLanguage?: string;
}

export interface TopicPreferences {
  interests: TopicInterest[];
  avoidTopics: string[];
  expertise: ExpertiseArea[];
}

export interface TopicInterest {
  topic: string;
  score: number; // 0-1
  lastMentioned: Date;
  mentionCount: number;
  sentiment: number; // -1 to 1
}

export interface ExpertiseArea {
  domain: string;
  level: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  confidence: number; // 0-1
}

export interface InteractionPreferences {
  preferredTimes: number[]; // hours of day (0-23)
  responseSpeed: 'immediate' | 'thoughtful' | 'flexible';
  initiativeLevel: number; // 0-1 (how proactive AI should be)
  privacyLevel: 'open' | 'moderate' | 'private';
}

export interface PersonalityProfile {
  traits: BigFiveTraits;
  communicationStyle: CommunicationStyle;
  cognitiveStyle: CognitiveStyle;
}

export interface BigFiveTraits {
  openness: number; // 0-1
  conscientiousness: number; // 0-1
  extraversion: number; // 0-1
  agreeableness: number; // 0-1
  emotionalStability: number; // 0-1
}

export interface CommunicationStyle {
  assertiveness: number; // 0-1
  analyticalThinking: number; // 0-1
  creativity: number; // 0-1
  empathy: number; // 0-1
  directness: number; // 0-1
}

export interface CognitiveStyle {
  detailOriented: number; // 0-1
  bigPictureThinking: number; // 0-1
  logicalReasoning: number; // 0-1
  intuitiveThinking: number; // 0-1
}

export interface UserStatistics {
  totalInteractions: number;
  averageResponseTime: number; // milliseconds
  averageMessageLength: number; // characters
  sentimentTrend: SentimentDataPoint[];
  topicDistribution: Map<string, number>;
  engagementMetrics: EngagementMetrics;
}

export interface SentimentDataPoint {
  date: Date;
  sentiment: number; // -1 to 1
  confidence: number; // 0-1
}

export interface EngagementMetrics {
  sessionCount: number;
  averageSessionDuration: number; // milliseconds
  messageFrequency: number; // messages per day
  responseRate: number; // 0-1
}

// Memory Types
export interface MemoryEntry {
  id: string;
  userId: string;
  type: MemoryType;
  content: MemoryContent;
  metadata: MemoryMetadata;
  context: MemoryContext;
  relationships: MemoryRelationships;
}

export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'working';

export interface MemoryContent {
  raw: string;
  summary: string;
  entities: Entity[];
  embedding: number[];
  keywords: string[];
}

export interface Entity {
  text: string;
  type: EntityType;
  salience: number; // 0-1
  sentiment?: number; // -1 to 1
  attributes?: Record<string, any>;
}

export type EntityType = 'person' | 'place' | 'organization' | 'event' | 'concept' | 'date' | 'product';

export interface MemoryMetadata {
  timestamp: Date;
  conversationId: string;
  importance: number; // 0-1
  emotionalValence: number; // -1 to 1
  emotionalArousal: number; // 0-1
  accessCount: number;
  lastAccessedAt: Date;
  decayFactor: number; // 0-1
  consolidationState: 'active' | 'consolidated' | 'archived';
  verificationStatus: 'unverified' | 'verified' | 'contradicted';
}

export interface MemoryContext {
  precedingMessages: string[];
  followingMessages: string[];
  topic: string;
  intent: ConversationIntent;
  mood: EmotionalContext;
}

export interface ConversationIntent {
  primary: IntentType;
  secondary?: IntentType[];
  confidence: number; // 0-1
}

export type IntentType = 
  | 'question'
  | 'answer'
  | 'request'
  | 'statement'
  | 'greeting'
  | 'farewell'
  | 'expression'
  | 'clarification'
  | 'confirmation';

export interface EmotionalContext {
  userEmotion: EmotionState;
  conversationTone: 'positive' | 'neutral' | 'negative' | 'mixed';
  intensity: number; // 0-1
}

export interface EmotionState {
  primary: EmotionType;
  secondary?: EmotionType[];
  valence: number; // -1 to 1
  arousal: number; // 0-1
}

export type EmotionType = 
  | 'joy'
  | 'sadness'
  | 'anger'
  | 'fear'
  | 'surprise'
  | 'disgust'
  | 'trust'
  | 'anticipation';

export interface MemoryRelationships {
  relatedMemories: string[];
  contradicts?: string[];
  supports?: string[];
  temporalLinks: TemporalLink[];
  causalLinks?: CausalLink[];
}

export interface TemporalLink {
  memoryId: string;
  relation: 'before' | 'after' | 'concurrent';
  timeDelta?: number; // milliseconds
}

export interface CausalLink {
  memoryId: string;
  relation: 'causes' | 'caused_by';
  confidence: number; // 0-1
}

// Conversation Types
export interface ConversationState {
  sessionId: string;
  userId: string;
  startedAt: Date;
  lastMessageAt: Date;
  status: 'active' | 'paused' | 'ended';
  context: ConversationContext;
  workingMemory: WorkingMemory;
}

export interface ConversationContext {
  currentTopic: TopicState;
  topicHistory: TopicTransition[];
  emotionalJourney: EmotionTransition[];
  unresolvedQuestions: UnresolvedQuestion[];
  keyPoints: KeyPoint[];
  goals: ConversationGoal[];
}

export interface TopicState {
  topic: string;
  startedAt: Date;
  depth: number; // 0-1
  userEngagement: number; // 0-1
}

export interface TopicTransition {
  fromTopic: string;
  toTopic: string;
  timestamp: Date;
  transitionType: 'natural' | 'abrupt' | 'user_initiated' | 'ai_initiated';
}

export interface EmotionTransition {
  timestamp: Date;
  fromEmotion: EmotionState;
  toEmotion: EmotionState;
  trigger?: string;
}

export interface UnresolvedQuestion {
  question: string;
  askedAt: Date;
  context: string;
  attempts: number;
  importance: number; // 0-1
}

export interface KeyPoint {
  content: string;
  timestamp: Date;
  importance: number; // 0-1
  category: string;
}

export interface ConversationGoal {
  type: 'inform' | 'assist' | 'entertain' | 'support' | 'explore';
  description: string;
  progress: number; // 0-1
  priority: number; // 0-1
}

export interface WorkingMemory {
  recentMessages: Message[];
  activeEntities: Map<string, Entity>;
  currentFocus: string[];
  shortTermGoals: string[];
}

export interface Message {
  id: string;
  content: string;
  timestamp: Date;
  role: 'user' | 'assistant';
  metadata?: MessageMetadata;
}

export interface MessageMetadata {
  intent?: ConversationIntent;
  emotion?: EmotionState;
  entities?: Entity[];
  responseTime?: number;
}

// Search and Retrieval Types
export interface MemorySearchQuery {
  userId: string;
  query?: string;
  embedding?: number[];
  filters?: MemoryFilters;
  limit?: number;
  includeRelated?: boolean;
}

export interface MemoryFilters {
  type?: MemoryType[];
  dateRange?: DateRange;
  minImportance?: number;
  categories?: string[];
  tags?: string[];
  emotionalValence?: NumberRange;
  verificationStatus?: Array<MemoryMetadata['verificationStatus']>;
}

export interface DateRange {
  start: Date;
  end: Date;
}

export interface NumberRange {
  min: number;
  max: number;
}

export interface MemorySearchResult {
  entries: ScoredMemoryEntry[];
  totalCount: number;
  searchMetadata: SearchMetadata;
}

export interface ScoredMemoryEntry extends MemoryEntry {
  relevanceScore: number; // 0-1
  matchedFields: string[];
  explanation?: string;
}

export interface SearchMetadata {
  executionTime: number; // milliseconds
  searchStrategy: 'semantic' | 'keyword' | 'hybrid';
  appliedFilters: string[];
}

// Response Generation Types
export interface ResponseContext {
  userProfile: UserProfile;
  conversationState: ConversationState;
  relevantMemories: MemoryEntry[];
  systemPrompt: string;
  constraints: ResponseConstraints;
}

export interface ResponseConstraints {
  maxLength?: number;
  tone?: TonePreference;
  mustInclude?: string[];
  mustAvoid?: string[];
  creativity?: number; // 0-1
  formality?: number; // 0-1
}

export interface TonePreference {
  primary: ToneType;
  modifiers?: ToneModifier[];
}

export type ToneType = 
  | 'friendly'
  | 'professional'
  | 'casual'
  | 'empathetic'
  | 'humorous'
  | 'serious'
  | 'encouraging'
  | 'neutral';

export type ToneModifier = 
  | 'warm'
  | 'enthusiastic'
  | 'gentle'
  | 'direct'
  | 'playful'
  | 'supportive';

// Analytics Types
export interface AnalyticsEvent {
  eventId: string;
  userId: string;
  timestamp: Date;
  eventType: EventType;
  data: Record<string, any>;
  sessionId?: string;
}

export type EventType = 
  | 'message_sent'
  | 'message_received'
  | 'memory_created'
  | 'memory_accessed'
  | 'profile_updated'
  | 'topic_changed'
  | 'emotion_detected'
  | 'goal_completed';

export interface UserInsights {
  userId: string;
  generatedAt: Date;
  insights: Insight[];
  recommendations: Recommendation[];
}

export interface Insight {
  type: InsightType;
  title: string;
  description: string;
  confidence: number; // 0-1
  evidence: string[];
  timestamp: Date;
}

export type InsightType = 
  | 'behavior_pattern'
  | 'preference_change'
  | 'emotional_trend'
  | 'topic_interest'
  | 'engagement_pattern';

export interface Recommendation {
  type: RecommendationType;
  action: string;
  reasoning: string;
  priority: number; // 0-1
  expectedImpact: string;
}

export type RecommendationType = 
  | 'conversation_style'
  | 'topic_suggestion'
  | 'engagement_timing'
  | 'response_format';

// Error Types
export class PersonalizationError extends Error {
  constructor(
    message: string,
    public code: ErrorCode,
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = 'PersonalizationError';
  }
}

export type ErrorCode = 
  | 'PROFILE_NOT_FOUND'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'INVALID_EMBEDDING'
  | 'SEARCH_FAILED'
  | 'PROFILE_UPDATE_FAILED'
  | 'MEMORY_CORRUPTION'
  | 'RATE_LIMIT_EXCEEDED';

// Configuration Types
export interface PersonalizationConfig {
  memory: MemoryConfig;
  profile: ProfileConfig;
  conversation: ConversationConfig;
  analytics: AnalyticsConfig;
}

export interface MemoryConfig {
  maxEntriesPerUser: number;
  consolidationThreshold: number;
  decayRate: number;
  embeddingDimensions: number;
  vectorDB: VectorDBConfig;
}

export interface VectorDBConfig {
  provider: 'chroma' | 'pinecone' | 'weaviate' | 'qdrant';
  connectionString: string;
  apiKey?: string;
  indexName: string;
}

export interface ProfileConfig {
  updateInterval: number; // milliseconds
  inferenceConfidenceThreshold: number; // 0-1
  relationshipProgressionThresholds: {
    familiar: number; // interaction count
    friend: number;
    collaborator: number;
  };
}

export interface ConversationConfig {
  contextWindowSize: number;
  workingMemoryDuration: number; // milliseconds
  topicSimilarityThreshold: number; // 0-1
  emotionDetectionSensitivity: number; // 0-1
}

export interface AnalyticsConfig {
  eventRetentionDays: number;
  insightGenerationInterval: number; // milliseconds
  minimumDataPoints: number;
}