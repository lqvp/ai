/**
 * Advanced Personalization Engine - Core Type Definitions
 * 
 * 革新的なパーソナライゼーション機能の型定義
 * ユーザーとの深い関係性構築のための包括的な型システム
 */

// =============================================================================
// Core User Profile Types
// =============================================================================

export interface DynamicUserProfile {
  // 基本識別情報
  userId: string;
  displayName?: string;
  preferredName?: string;
  avatarUrl?: string;
  
  // 性格特性分析 (Big Five + 拡張指標)
  personality: PersonalityTraits;
  
  // コミュニケーション設定
  communication: CommunicationPreferences;
  
  // 関係性レベル管理
  relationshipLevel: RelationshipState;
  
  // 興味・専門分野
  interests: Interest[];
  expertise: ExpertiseArea[];
  goals: Goal[];
  
  // 行動パターン分析
  behaviorPatterns: BehaviorPatterns;
  
  // 学習・成長履歴
  learningJourney: LearningJourney;
  
  // メタデータ
  metadata: ProfileMetadata;
}

export interface PersonalityTraits {
  // Big Five Model
  openness: number;              // 0-1: 新しい体験への開放性
  conscientiousness: number;     // 0-1: 誠実性・責任感
  extraversion: number;          // 0-1: 外向性
  agreeableness: number;         // 0-1: 協調性
  neuroticism: number;          // 0-1: 神経症的傾向
  
  // 拡張指標
  curiosity: number;            // 0-1: 学習意欲・探究心
  humor: number;               // 0-1: ユーモア嗜好
  technicalApproach: number;   // 0-1: 技術的アプローチ好み
  creativity: number;          // 0-1: 創造性指向
  patience: number;            // 0-1: 忍耐力
  detail_orientation: number;  // 0-1: 細部への注意
  
  // 信頼度情報
  confidence: TraitConfidence;
  lastUpdated: Date;
}

export interface TraitConfidence {
  [key: string]: number; // 各特性の推定信頼度 (0-1)
}

export interface CommunicationPreferences {
  // スタイル設定
  preferredFormality: number;      // 0-1: カジュアル ↔ フォーマル
  emotionalExpression: number;     // 0-1: 控えめ ↔ 豊か
  responseLength: ResponseLengthPreference;
  emojiUsage: number;             // 0-1: 使用頻度
  reactionStyle: ReactionStyle;
  
  // 言語的特徴
  vocabularyLevel: VocabularyLevel;
  technicalTermUsage: number;     // 0-1: 専門用語使用頻度
  
  // インタラクション設定
  questioningStyle: QuestioningStyle;
  feedbackPreference: FeedbackPreference;
  conflictResolution: ConflictResolutionStyle;
}

export type ResponseLengthPreference = 'brief' | 'moderate' | 'detailed' | 'adaptive';
export type ReactionStyle = 'immediate' | 'thoughtful' | 'delayed';
export type VocabularyLevel = 'simple' | 'intermediate' | 'advanced' | 'expert';
export type QuestioningStyle = 'direct' | 'gentle' | 'socratic' | 'supportive';
export type FeedbackPreference = 'direct' | 'constructive' | 'encouraging' | 'detailed';
export type ConflictResolutionStyle = 'avoidant' | 'collaborative' | 'competitive' | 'accommodating';

// =============================================================================
// Relationship Management Types
// =============================================================================

export interface RelationshipState {
  stage: RelationshipStage;
  trustLevel: number;              // 0-1: 信頼度
  intimacyLevel: number;           // 0-1: 親密度
  sharedExperiences: number;       // 累積体験数
  conflictHistory: ConflictEvent[];
  milestones: RelationshipMilestone[];
  
  // 関係性の質
  communicationQuality: number;    // 0-1: コミュニケーション品質
  mutualUnderstanding: number;     // 0-1: 相互理解度
  emotionalConnection: number;     // 0-1: 感情的つながり
  
  // 関係性の発展
  progressionRate: number;         // 関係性発展速度
  plateauRisk: number;            // 0-1: 停滞リスク
  lastSignificantInteraction: Date;
}

export type RelationshipStage = 
  | 'stranger'        // 初対面・未知
  | 'acquaintance'    // 知り合い
  | 'friend'          // 友人
  | 'close_friend'    // 親友
  | 'collaborator'    // 協力者・パートナー
  | 'mentor_mentee'   // メンター関係
  | 'confidant';      // 信頼できる相談相手

export interface ConflictEvent {
  id: string;
  timestamp: Date;
  type: ConflictType;
  severity: number;              // 0-1: 深刻度
  context: string;
  resolution: ConflictResolution;
  outcome: ConflictOutcome;
  learnings: string[];
}

export type ConflictType = 
  | 'misunderstanding' 
  | 'disagreement' 
  | 'unmet_expectation' 
  | 'communication_breakdown'
  | 'value_clash';

export interface ConflictResolution {
  strategy: string;
  timeToResolve: number;        // 分単位
  satisfactionLevel: number;    // 0-1: 解決満足度
  preventionMeasures: string[];
}

export type ConflictOutcome = 'resolved' | 'partially_resolved' | 'unresolved' | 'escalated';

export interface RelationshipMilestone {
  id: string;
  type: MilestoneType;
  timestamp: Date;
  description: string;
  significance: number;         // 0-1: 重要度
  emotionalImpact: number;     // 0-1: 感情的影響
}

export type MilestoneType = 
  | 'first_conversation'
  | 'personal_disclosure'
  | 'successful_collaboration'
  | 'conflict_resolution'
  | 'achievement_shared'
  | 'trust_milestone'
  | 'intimacy_deepening';

// =============================================================================
// Knowledge and Learning Types
// =============================================================================

export interface Interest {
  id: string;
  topic: string;
  category: InterestCategory;
  intensity: number;           // 0-1: 興味の強さ
  expertise_level: number;     // 0-1: その分野での専門性
  firstMentioned: Date;
  lastMentioned: Date;
  mentionCount: number;
  
  // 関連情報
  relatedInterests: string[];  // 関連する興味のID
  keywords: string[];
  sentiment: InterestSentiment;
  
  // 発展性
  growthPotential: number;     // 0-1: 成長可能性
  learningGoals: string[];
}

export type InterestCategory = 
  | 'technology' | 'science' | 'arts' | 'sports' | 'music' 
  | 'literature' | 'philosophy' | 'business' | 'health'
  | 'travel' | 'food' | 'entertainment' | 'education'
  | 'social_issues' | 'lifestyle' | 'hobbies' | 'other';

export type InterestSentiment = 'passionate' | 'positive' | 'neutral' | 'declining' | 'negative';

export interface ExpertiseArea {
  id: string;
  domain: string;
  subdomains: string[];
  level: ExpertiseLevel;
  confidence: number;          // 0-1: 推定精度
  evidenceQuality: number;     // 0-1: 証拠の質
  
  // 検証情報
  verificationSources: string[];
  demonstratedSkills: string[];
  knowledgeGaps: string[];
  
  // 動的情報
  recentActivity: Date;
  progressRate: number;        // 成長速度
  teachingAbility: number;     // 0-1: 他者への説明能力
}

export type ExpertiseLevel = 'novice' | 'beginner' | 'intermediate' | 'advanced' | 'expert' | 'master';

export interface Goal {
  id: string;
  title: string;
  description: string;
  type: GoalType;
  priority: number;            // 0-1: 優先度
  status: GoalStatus;
  
  // 時間管理
  createdAt: Date;
  targetDate?: Date;
  completedAt?: Date;
  
  // 進捗管理
  progress: number;            // 0-1: 進捗率
  milestones: GoalMilestone[];
  obstacles: Obstacle[];
  
  // 支援情報
  supportNeeded: SupportType[];
  relatedInterests: string[];
  motivationLevel: number;     // 0-1: モチベーション
}

export type GoalType = 'learning' | 'career' | 'personal' | 'creative' | 'health' | 'relationship' | 'project';
export type GoalStatus = 'active' | 'paused' | 'completed' | 'abandoned' | 'deferred';
export type SupportType = 'information' | 'motivation' | 'accountability' | 'resources' | 'connections';

export interface GoalMilestone {
  id: string;
  title: string;
  targetDate: Date;
  completed: boolean;
  completedAt?: Date;
  significance: number;        // 0-1: 重要度
}

export interface Obstacle {
  id: string;
  description: string;
  type: ObstacleType;
  severity: number;           // 0-1: 深刻度
  solutions: Solution[];
  status: ObstacleStatus;
}

export type ObstacleType = 'time' | 'resources' | 'knowledge' | 'motivation' | 'external' | 'skill';
export type ObstacleStatus = 'identified' | 'addressing' | 'resolved' | 'escalated';

export interface Solution {
  description: string;
  feasibility: number;        // 0-1: 実現可能性
  effectiveness: number;      // 0-1: 効果予測
  tried: boolean;
  result?: SolutionResult;
}

export type SolutionResult = 'successful' | 'partially_successful' | 'unsuccessful' | 'pending';

// =============================================================================
// Behavior Pattern Types
// =============================================================================

export interface BehaviorPatterns {
  // 時間パターン
  activeHours: number[];                    // 24時間表記での活動時間
  sessionPatterns: SessionPattern[];
  
  // コミュニケーションパターン
  responsePatterns: ResponsePattern[];
  questionTypes: QuestionTypeFrequency[];
  topicTransitions: TopicTransition[];
  
  // 学習パターン
  learningBehavior: LearningBehaviorPattern;
  helpSeekingBehavior: HelpSeekingPattern;
  
  // 感情パターン
  emotionalPatterns: EmotionalPattern[];
  
  // 意思決定パターン
  decisionMakingStyle: DecisionMakingStyle;
}

export interface SessionPattern {
  averageDuration: number;     // 分単位
  messageFrequency: number;    // メッセージ/分
  topicCount: number;         // セッションあたりのトピック数
  engagementLevel: number;    // 0-1: エンゲージメント
}

export interface ResponsePattern {
  averageResponseTime: number; // 秒単位
  responseLength: number;      // 文字数
  emotionalTone: EmotionalTone;
  questionRatio: number;       // 0-1: 質問の割合
}

export type EmotionalTone = 'enthusiastic' | 'neutral' | 'concerned' | 'frustrated' | 'curious' | 'analytical';

export interface QuestionTypeFrequency {
  type: QuestionType;
  frequency: number;          // 0-1: 相対頻度
  complexity: number;         // 0-1: 複雑さ
}

export type QuestionType = 
  | 'factual' | 'analytical' | 'creative' | 'personal' 
  | 'hypothetical' | 'problem_solving' | 'clarification'
  | 'opinion' | 'advice' | 'process';

export interface TopicTransition {
  fromTopic: string;
  toTopic: string;
  frequency: number;
  transitionStyle: TransitionStyle;
}

export type TransitionStyle = 'smooth' | 'abrupt' | 'logical' | 'associative' | 'tangential';

export interface LearningBehaviorPattern {
  preferredLearningStyle: LearningStyle[];
  attentionSpan: number;              // 分単位
  repetitionNeeds: number;            // 0-1: 反復の必要性
  feedbackSensitivity: number;        // 0-1: フィードバックへの敏感さ
  experimentationTendency: number;    // 0-1: 実験的試行の傾向
}

export type LearningStyle = 'visual' | 'auditory' | 'kinesthetic' | 'reading' | 'discussion' | 'practice';

export interface HelpSeekingPattern {
  frequency: number;                  // ヘルプ要求頻度
  specificity: number;                // 0-1: 質問の具体性
  persistenceLevel: number;           // 0-1: 解決への粘り強さ
  preferredSupportType: SupportType[];
  autonomyLevel: number;              // 0-1: 自律性レベル
}

export interface EmotionalPattern {
  dominantEmotion: EmotionType;
  emotionalRange: number;             // 0-1: 感情の振れ幅
  emotionalStability: number;         // 0-1: 感情の安定性
  empathyLevel: number;              // 0-1: 共感性
  emotionalExpression: number;        // 0-1: 感情表現の豊かさ
}

export type EmotionType = 'joy' | 'sadness' | 'anger' | 'fear' | 'surprise' | 'love' | 'neutral' | 'mixed';

export interface DecisionMakingStyle {
  analyticalVsIntuitive: number;      // 0-1: 分析的 ↔ 直感的
  quickVsDeliberate: number;          // 0-1: 迅速 ↔ 慎重
  independentVsCollaborative: number; // 0-1: 独立 ↔ 協力
  riskTolerance: number;              // 0-1: リスク許容度
  informationNeed: number;            // 0-1: 情報要求度
}

// =============================================================================
// Learning and Growth Types
// =============================================================================

export interface LearningJourney {
  skillsAcquired: Skill[];
  progressMarkers: ProgressMarker[];
  challengesFaced: Challenge[];
  achievements: Achievement[];
  learningMilestones: LearningMilestone[];
  
  // 学習メトリクス
  overallProgress: number;            // 0-1: 全体的成長
  learningVelocity: number;          // 学習速度
  retentionRate: number;             // 0-1: 情報保持率
  applicationRate: number;           // 0-1: 知識応用率
}

export interface Skill {
  id: string;
  name: string;
  category: SkillCategory;
  level: SkillLevel;
  acquiredAt: Date;
  lastPracticed: Date;
  confidence: number;                 // 0-1: 自信度
  
  // 発展性
  developmentPotential: number;       // 0-1: 発展可能性
  relatedSkills: string[];
  prerequisites: string[];
  applications: string[];
}

export type SkillCategory = 
  | 'technical' | 'creative' | 'analytical' | 'communication'
  | 'leadership' | 'problem_solving' | 'interpersonal'
  | 'organization' | 'learning' | 'domain_specific';

export type SkillLevel = 'awareness' | 'novice' | 'competent' | 'proficient' | 'expert' | 'mastery';

export interface ProgressMarker {
  id: string;
  timestamp: Date;
  type: ProgressType;
  description: string;
  significance: number;               // 0-1: 重要度
  evidenceQuality: number;           // 0-1: 証拠の質
  
  // 関連情報
  relatedSkills: string[];
  relatedGoals: string[];
  context: string;
}

export type ProgressType = 
  | 'skill_acquisition' | 'knowledge_expansion' | 'understanding_deepening'
  | 'application_success' | 'teaching_others' | 'problem_solving'
  | 'creative_breakthrough' | 'perspective_shift';

export interface Challenge {
  id: string;
  title: string;
  description: string;
  type: ChallengeType;
  difficulty: number;                 // 0-1: 難易度
  facedAt: Date;
  status: ChallengeStatus;
  
  // 解決プロセス
  approachTaken: string[];
  timeInvested: number;              // 時間（分）
  supportReceived: SupportReceived[];
  outcome: ChallengeOutcome;
  
  // 学習価値
  learningValue: number;             // 0-1: 学習価値
  skillsImproved: string[];
  insightsGained: string[];
}

export type ChallengeType = 
  | 'technical' | 'conceptual' | 'creative' | 'interpersonal'
  | 'time_management' | 'resource_constraint' | 'motivation'
  | 'complexity' | 'ambiguity' | 'pressure';

export type ChallengeStatus = 'facing' | 'progress' | 'resolved' | 'abandoned' | 'escalated';

export interface SupportReceived {
  type: SupportType;
  source: string;
  effectiveness: number;             // 0-1: 効果
  satisfaction: number;              // 0-1: 満足度
}

export type ChallengeOutcome = 'success' | 'partial_success' | 'learning_experience' | 'failure' | 'ongoing';

export interface Achievement {
  id: string;
  title: string;
  description: string;
  type: AchievementType;
  achievedAt: Date;
  recognitionLevel: RecognitionLevel;
  
  // 影響・価値
  personalSignificance: number;       // 0-1: 個人的意義
  skillImpact: string[];             // 影響を受けたスキル
  confidenceBoost: number;           // 0-1: 自信向上
  
  // 関連情報
  relatedGoals: string[];
  relatedChallenges: string[];
  celebrationLevel: number;          // 0-1: 祝福度
}

export type AchievementType = 
  | 'skill_mastery' | 'goal_completion' | 'creative_success'
  | 'problem_solving' | 'helping_others' | 'knowledge_sharing'
  | 'innovation' | 'collaboration' | 'leadership' | 'persistence';

export type RecognitionLevel = 'self' | 'peer' | 'mentor' | 'community' | 'formal' | 'public';

export interface LearningMilestone {
  id: string;
  timestamp: Date;
  type: MilestoneType;
  description: string;
  significance: number;              // 0-1: 重要度
  
  // 成長指標
  skillsGained: string[];
  knowledgeAreas: string[];
  capabilitiesUnlocked: string[];
  
  // 未来への影響
  futureOpportunities: string[];
  nextLearningSteps: string[];
}

// =============================================================================
// Memory System Types
// =============================================================================

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

export interface MemorySearchResult {
  entries: MemoryEntry[];
  relevanceScores: number[];
  totalCount: number;
  categories: string[];
  commonTags: string[];
}

export interface MemoryEntry {
  id: string;
  userId: string;
  content: string;
  summary: string;
  category: MemoryCategory;
  importance: number;                // 0-1: 重要度
  
  // 分析結果
  analysis: ConversationAnalysis;
  
  // コンテキスト情報
  context: MemoryContext;
  
  // メタデータ
  metadata: MemoryMetadata;
  
  // 関連性情報
  relationships: MemoryRelationship[];
  
  // アクセス情報
  accessLog: MemoryAccess[];
}

export type MemoryCategory = 
  | 'personal_info' | 'preferences' | 'goals' | 'experiences'
  | 'knowledge' | 'skills' | 'relationships' | 'achievements'
  | 'challenges' | 'emotions' | 'plans' | 'insights'
  | 'feedback' | 'milestones' | 'context' | 'other';

export interface MemoryContext {
  conversationId: string;
  messageId?: string;
  timestamp: Date;
  sessionContext: SessionContext;
  emotionalContext: EmotionalContext;
  topicalContext: TopicalContext;
  socialContext: SocialContext;
}

export interface SessionContext {
  sessionId: string;
  sessionDuration: number;           // 分単位
  messageCount: number;
  topicsDiscussed: string[];
  overallTone: EmotionalTone;
}

export interface EmotionalContext {
  userEmotion: EmotionAnalysis;
  aiEmotion: EmotionAnalysis;
  emotionalArc: EmotionalChange[];
  emotionalCatalysts: string[];
}

export interface TopicalContext {
  mainTopic: string;
  subTopics: string[];
  topicDepth: number;               // 0-1: 話題の深さ
  topicShifts: TopicTransition[];
  expertiseLevel: number;           // 0-1: その話題でのユーザー専門性
}

export interface SocialContext {
  relationshipDynamics: string[];
  powerBalance: number;             // 0-1: 力関係バランス
  intimacyLevel: number;            // 0-1: 親密度
  formalityLevel: number;           // 0-1: フォーマル度
  collaborationMode: boolean;
}

export interface MemoryMetadata {
  createdAt: Date;
  updatedAt: Date;
  version: number;                  // バージョン管理
  accessCount: number;              // アクセス回数
  lastAccessedAt: Date;             // 最終アクセス日時
  
  // 品質情報
  confidence: number;               // 0-1: 情報の信頼度
  source: MemorySource;
  verification: VerificationStatus;
  
  // 管理情報
  tags: string[];
  priority: number;                 // 0-1: 優先度
  retention: RetentionPolicy;
  importance: number;               // 0-1: 重要度
  category: string;                 // カテゴリー
  
  // アクセス制御
  privacy: PrivacyLevel;
  shareability: ShareabilityLevel;
}

export type MemorySource = 'direct_statement' | 'inferred' | 'observed' | 'contextual' | 'third_party';
export type VerificationStatus = 'unverified' | 'self_reported' | 'cross_referenced' | 'validated' | 'disputed';
export type RetentionPolicy = 'permanent' | 'long_term' | 'medium_term' | 'short_term' | 'session_only';
export type PrivacyLevel = 'public' | 'shared' | 'private' | 'confidential' | 'secret';
export type ShareabilityLevel = 'freely_shareable' | 'context_dependent' | 'restricted' | 'non_shareable';

export interface MemoryRelationship {
  type: RelationshipType;
  targetMemoryId: string;
  strength: number;                 // 0-1: 関連性の強さ
  directionality: RelationshipDirectionality;
  createdAt: Date;
}

export type RelationshipType = 
  | 'causal' | 'temporal' | 'conceptual' | 'emotional'
  | 'contradictory' | 'supportive' | 'contextual' | 'hierarchical';

export type RelationshipDirectionality = 'unidirectional' | 'bidirectional' | 'mutual';

export interface MemoryAccess {
  timestamp: Date;
  accessType: AccessType;
  context: string;
  relevanceScore: number;           // 0-1: その時点での関連性
  used: boolean;                    // 実際に応答生成に使用されたか
}

export type AccessType = 'retrieval' | 'update' | 'verification' | 'cross_reference' | 'consolidation';

// =============================================================================
// Analysis and Intelligence Types
// =============================================================================

export interface ConversationAnalysis {
  // 感情分析
  emotion: EmotionAnalysis;
  
  // 意図分析
  intent: IntentAnalysis;
  
  // トピック分析
  topic: TopicAnalysis;
  
  // 関係性分析
  relationship: RelationshipAnalysis;
  
  // 学習分析
  learning: LearningAnalysis;
  
  // パーソナライゼーション推奨
  personalization: PersonalizationRecommendation;
  
  // メタ分析
  meta: MetaAnalysis;
}

export interface EmotionAnalysis {
  primaryEmotion: EmotionType;
  emotionIntensity: number;         // 0-1: 感情の強さ
  emotionMix: { [emotion: string]: number }; // 複合感情
  sentiment: SentimentScore;
  emotionalStability: number;       // 0-1: 感情の安定性
  
  // 文脈的感情情報
  triggers: EmotionalTrigger[];
  expressionStyle: EmotionExpressionStyle;
  regulationNeeds: EmotionRegulationNeed[];
}

export interface SentimentScore {
  polarity: number;                 // -1 to 1: 負 ↔ 正
  subjectivity: number;             // 0-1: 客観的 ↔ 主観的
  confidence: number;               // 0-1: 分析信頼度
}

export interface EmotionalTrigger {
  trigger: string;
  type: TriggerType;
  intensity: number;                // 0-1: トリガー強度
  historicalPattern: boolean;       // 過去にも見られたパターンか
}

export type TriggerType = 
  | 'topic' | 'phrase' | 'situation' | 'memory'
  | 'achievement' | 'setback' | 'recognition' | 'conflict';

export type EmotionExpressionStyle = 
  | 'direct' | 'subtle' | 'metaphorical' | 'suppressed'
  | 'amplified' | 'mixed' | 'delayed' | 'masked';

export interface EmotionRegulationNeed {
  need: RegulationNeedType;
  urgency: number;                  // 0-1: 緊急度
  suggestedApproach: string[];
}

export type RegulationNeedType = 
  | 'validation' | 'calming' | 'encouragement' | 'distraction'
  | 'processing' | 'reframing' | 'support' | 'celebration';

export interface IntentAnalysis {
  primaryIntent: IntentType;
  intentConfidence: number;         // 0-1: 意図推定信頼度
  subIntents: SubIntent[];
  
  // 意図の特性
  urgency: number;                  // 0-1: 緊急度
  complexity: number;               // 0-1: 複雑さ
  specificity: number;              // 0-1: 具体性
  
  // 期待される応答
  expectedResponseType: ResponseType[];
  responsePreferences: ResponsePreference[];
}

export type IntentType = 
  | 'information_seeking' | 'problem_solving' | 'emotional_support'
  | 'creative_collaboration' | 'decision_support' | 'learning'
  | 'planning' | 'reflection' | 'celebration' | 'venting'
  | 'exploration' | 'confirmation' | 'correction' | 'update';

export interface SubIntent {
  intent: IntentType;
  weight: number;                   // 0-1: サブ意図の重み
  context: string;
}

export type ResponseType = 
  | 'informational' | 'analytical' | 'empathetic' | 'creative'
  | 'directive' | 'supportive' | 'clarifying' | 'expanding';

export interface ResponsePreference {
  preference: string;
  importance: number;               // 0-1: 重要度
  rationale: string;
}

export interface TopicAnalysis {
  mainTopic: string;
  subTopics: string[];
  topicCategory: TopicCategory;
  
  // トピックの特性
  complexity: number;               // 0-1: 複雑さ
  novelty: number;                  // 0-1: 新規性（ユーザーにとって）
  expertise_required: number;       // 0-1: 必要専門性レベル
  
  // エンティティ抽出
  entities: Entity[];
  
  // キーワード分析
  keywords: Keyword[];
  
  // トピック関連性
  relatedTopics: RelatedTopic[];
  historicalRelevance: number;      // 0-1: 過去の会話との関連性
}

export type TopicCategory = 
  | 'personal' | 'professional' | 'academic' | 'creative'
  | 'technical' | 'social' | 'philosophical' | 'practical'
  | 'emotional' | 'recreational' | 'health' | 'relationships';

export interface Entity {
  text: string;
  type: EntityType;
  confidence: number;               // 0-1: 抽出信頼度
  context: string;
  relationships: EntityRelationship[];
}

export type EntityType = 
  | 'person' | 'organization' | 'location' | 'product'
  | 'event' | 'concept' | 'skill' | 'goal'
  | 'time' | 'number' | 'technology' | 'method';

export interface EntityRelationship {
  relatedEntity: string;
  relationshipType: string;
  confidence: number;               // 0-1: 関係性信頼度
}

export interface Keyword {
  term: string;
  importance: number;               // 0-1: 重要度
  frequency: number;                // 出現頻度
  context: string[];
  sentiment: number;                // -1 to 1: 感情極性
}

export interface RelatedTopic {
  topic: string;
  similarity: number;               // 0-1: 類似度
  connectionType: ConnectionType;
  historicalContext: string[];
}

export type ConnectionType = 
  | 'conceptual' | 'practical' | 'emotional' | 'temporal'
  | 'causal' | 'hierarchical' | 'analogical' | 'contrasting';

export interface RelationshipAnalysis {
  currentStage: RelationshipStage;
  stageProgression: StageProgression;
  trustIndicators: TrustIndicator[];
  intimacyFactors: IntimacyFactor[];
  
  // 関係性の質
  communicationQuality: CommunicationQuality;
  conflictRisk: ConflictRisk;
  growthOpportunities: GrowthOpportunity[];
  
  // 推奨アクション
  recommendedActions: RelationshipAction[];
}

export interface StageProgression {
  direction: ProgressionDirection;
  velocity: number;                 // 0-1: 進展速度
  factors: ProgressionFactor[];
  barriers: ProgressionBarrier[];
  catalysts: ProgressionCatalyst[];
}

export type ProgressionDirection = 'advancing' | 'stable' | 'regressing' | 'fluctuating';

export interface ProgressionFactor {
  factor: string;
  impact: number;                   // -1 to 1: 影響度
  controllability: number;          // 0-1: 制御可能性
}

export interface ProgressionBarrier {
  barrier: string;
  severity: number;                 // 0-1: 深刻度
  addressability: number;           // 0-1: 対処可能性
  suggestedApproach: string[];
}

export interface ProgressionCatalyst {
  catalyst: string;
  potential: number;                // 0-1: 潜在力
  accessibility: number;            // 0-1: 利用しやすさ
  suggestedActivation: string[];
}

export interface TrustIndicator {
  indicator: string;
  type: TrustType;
  strength: number;                 // 0-1: 強度
  trend: TrustTrend;
  reliability: number;              // 0-1: 信頼性
}

export type TrustType = 'competence' | 'benevolence' | 'integrity' | 'predictability' | 'transparency';
export type TrustTrend = 'building' | 'stable' | 'eroding' | 'recovering' | 'fluctuating';

export interface IntimacyFactor {
  factor: string;
  type: IntimacyType;
  level: number;                    // 0-1: レベル
  development: IntimacyDevelopment;
  sustainability: number;           // 0-1: 持続可能性
}

export type IntimacyType = 'emotional' | 'intellectual' | 'experiential' | 'value_based' | 'goal_aligned';
export type IntimacyDevelopment = 'emerging' | 'developing' | 'established' | 'deepening' | 'stable';

export interface CommunicationQuality {
  clarity: number;                  // 0-1: 明確性
  empathy: number;                  // 0-1: 共感性
  responsiveness: number;           // 0-1: 応答性
  adaptability: number;             // 0-1: 適応性
  authenticity: number;             // 0-1: 真正性
  
  // 問題領域
  improvementAreas: ImprovementArea[];
  strengths: CommunicationStrength[];
}

export interface ImprovementArea {
  area: string;
  currentLevel: number;             // 0-1: 現在レベル
  targetLevel: number;              // 0-1: 目標レベル
  suggestedActions: string[];
  priority: number;                 // 0-1: 優先度
}

export interface CommunicationStrength {
  strength: string;
  level: number;                    // 0-1: 強度
  consistency: number;              // 0-1: 一貫性
  leverage: string[];               // 活用方法
}

export interface ConflictRisk {
  overall: number;                  // 0-1: 全体的リスク
  categories: ConflictRiskCategory[];
  triggers: ConflictTrigger[];
  preventionStrategies: PreventionStrategy[];
  earlyWarnings: EarlyWarning[];
}

export interface ConflictRiskCategory {
  category: ConflictType;
  risk: number;                     // 0-1: リスク度
  indicators: string[];
  mitigation: string[];
}

export interface ConflictTrigger {
  trigger: string;
  likelihood: number;               // 0-1: 発生可能性
  impact: number;                   // 0-1: 影響度
  preventionActions: string[];
}

export interface PreventionStrategy {
  strategy: string;
  effectiveness: number;            // 0-1: 効果
  difficulty: number;               // 0-1: 実施難易度
  implementation: string[];
}

export interface EarlyWarning {
  signal: string;
  sensitivity: number;              // 0-1: 感度
  specificity: number;              // 0-1: 特異性
  responseActions: string[];
}

export interface GrowthOpportunity {
  opportunity: string;
  type: OpportunityType;
  potential: number;                // 0-1: 成長可能性
  accessibility: number;            // 0-1: 実現しやすさ
  timeline: OpportunityTimeline;
  requirements: string[];
}

export type OpportunityType = 
  | 'trust_building' | 'intimacy_deepening' | 'communication_improvement'
  | 'shared_experience' | 'mutual_growth' | 'collaboration_enhancement';

export type OpportunityTimeline = 'immediate' | 'short_term' | 'medium_term' | 'long_term' | 'ongoing';

export interface RelationshipAction {
  action: string;
  type: ActionType;
  priority: number;                 // 0-1: 優先度
  expected_impact: number;          // 0-1: 期待効果
  difficulty: number;               // 0-1: 実行難易度
  timeline: string;
  success_indicators: string[];
}

export type ActionType = 
  | 'communication' | 'engagement' | 'support' | 'challenge'
  | 'disclosure' | 'boundary_setting' | 'celebration' | 'reflection';

export interface LearningAnalysis {
  learningOpportunity: LearningOpportunity;
  knowledgeGap: KnowledgeGap[];
  skillDevelopment: SkillDevelopmentOpportunity[];
  
  // 学習支援推奨
  recommendedApproach: LearningApproach;
  supportNeeds: LearningSupportNeed[];
  
  // 進捗評価
  currentProgress: LearningProgress;
  nextSteps: LearningNextStep[];
}

export interface LearningOpportunity {
  type: LearningOpportunityType;
  domain: string;
  level: LearningLevel;
  value: number;                    // 0-1: 学習価値
  accessibility: number;            // 0-1: 学習しやすさ
  prerequisitesMet: boolean;
  timeInvestment: number;           // 推定時間（分）
}

export type LearningOpportunityType = 
  | 'new_concept' | 'skill_building' | 'knowledge_deepening'
  | 'application_practice' | 'perspective_broadening' | 'problem_solving'
  | 'creative_exploration' | 'critical_thinking' | 'synthesis';

export type LearningLevel = 'awareness' | 'basic' | 'intermediate' | 'advanced' | 'expert';

export interface KnowledgeGap {
  area: string;
  gapSize: number;                  // 0-1: ギャップの大きさ
  criticality: number;              // 0-1: 重要度
  fillability: number;              // 0-1: 埋めやすさ
  dependencies: string[];
  suggestedResources: string[];
}

export interface SkillDevelopmentOpportunity {
  skill: string;
  currentLevel: SkillLevel;
  targetLevel: SkillLevel;
  development_path: DevelopmentStep[];
  practiceOpportunities: string[];
  assessmentMethods: string[];
}

export interface DevelopmentStep {
  step: string;
  order: number;
  difficulty: number;               // 0-1: 難易度
  timeRequired: number;             // 分単位
  resources: string[];
  successCriteria: string[];
}

export interface LearningApproach {
  primaryStyle: LearningStyle;
  supportingStyles: LearningStyle[];
  pacing: LearningPacing;
  structure: LearningStructure;
  feedback: FeedbackApproach;
}

export type LearningPacing = 'intensive' | 'moderate' | 'gradual' | 'flexible' | 'self_directed';
export type LearningStructure = 'linear' | 'modular' | 'spiral' | 'exploratory' | 'project_based';
export type FeedbackApproach = 'immediate' | 'milestone' | 'reflective' | 'peer' | 'self_assessment';

export interface LearningSupportNeed {
  need: SupportNeedType;
  urgency: number;                  // 0-1: 緊急度
  provision_method: string[];
  success_indicators: string[];
}

export type SupportNeedType = 
  | 'motivation' | 'clarification' | 'practice_opportunity'
  | 'feedback' | 'resource_access' | 'peer_connection'
  | 'mentoring' | 'assessment' | 'application_guidance';

export interface LearningProgress {
  overallProgress: number;          // 0-1: 全体進捗
  recentAchievements: string[];
  currentChallenges: string[];
  motivationLevel: number;          // 0-1: モチベーション
  retentionQuality: number;         // 0-1: 理解の定着度
}

export interface LearningNextStep {
  step: string;
  type: NextStepType;
  priority: number;                 // 0-1: 優先度
  readiness: number;                // 0-1: 準備度
  resource_requirements: string[];
  timeline: string;
}

export type NextStepType = 
  | 'practice' | 'exploration' | 'deepening' | 'application'
  | 'teaching' | 'assessment' | 'connection' | 'reflection';

export interface PersonalizationRecommendation {
  responseStyle: ResponseStyleRecommendation;
  contentAdaptation: ContentAdaptationRecommendation;
  interactionApproach: InteractionApproachRecommendation;
  
  // 動的調整
  adaptations: PersonalizationAdaptation[];
  
  // フィードバック統合
  feedbackIntegration: FeedbackIntegration;
}

export interface ResponseStyleRecommendation {
  tone: ResponseTone;
  formality: number;                // 0-1: フォーマル度
  length: ResponseLengthRecommendation;
  emotionalSupport: EmotionalSupportLevel;
  technicality: number;             // 0-1: 技術性
  creativity: number;               // 0-1: 創造性
}

export type ResponseTone = 
  | 'warm' | 'professional' | 'enthusiastic' | 'supportive'
  | 'analytical' | 'encouraging' | 'gentle' | 'direct'
  | 'playful' | 'respectful' | 'inspiring' | 'calming';

export interface ResponseLengthRecommendation {
  preferred: ResponseLengthPreference;
  flexibility: number;              // 0-1: 柔軟性
  context_sensitivity: number;      // 0-1: 文脈感度
}

export type EmotionalSupportLevel = 'minimal' | 'moderate' | 'high' | 'adaptive' | 'proactive';

export interface ContentAdaptationRecommendation {
  complexityLevel: number;          // 0-1: 複雑さレベル
  exampleUsage: ExampleUsageLevel;
  analogyPreference: number;        // 0-1: 類推使用度
  visualAidSuggestion: boolean;
  practicalApplication: number;     // 0-1: 実用性重視度
}

export type ExampleUsageLevel = 'none' | 'minimal' | 'moderate' | 'extensive' | 'primary';

export interface InteractionApproachRecommendation {
  questioningStyle: QuestioningStyle;
  challengeLevel: number;           // 0-1: 挑戦度
  autonomySupport: number;          // 0-1: 自律性支援
  collaborationLevel: number;       // 0-1: 協力度
  patience: number;                 // 0-1: 忍耐レベル
}

export interface PersonalizationAdaptation {
  aspect: AdaptationAspect;
  currentSetting: number;           // 0-1: 現在設定
  recommendedSetting: number;       // 0-1: 推奨設定
  confidence: number;               // 0-1: 推奨信頼度
  rationale: string;
  
  // 適応性情報
  adaptationSpeed: AdaptationSpeed;
  monitoring: boolean;              // 効果モニタリングが必要か
}

export type AdaptationAspect = 
  | 'formality' | 'emotional_expression' | 'technicality'
  | 'creativity' | 'challenge_level' | 'support_level'
  | 'response_length' | 'questioning_intensity';

export type AdaptationSpeed = 'immediate' | 'gradual' | 'slow' | 'experimental';

export interface FeedbackIntegration {
  explicit: ExplicitFeedback[];
  implicit: ImplicitFeedback[];
  behavioral: BehavioralFeedback[];
  
  // フィードバック活用
  integrationStrategy: IntegrationStrategy;
  validation: ValidationMethod[];
}

export interface ExplicitFeedback {
  feedback: string;
  type: FeedbackType;
  sentiment: number;                // -1 to 1: 感情極性
  specificity: number;              // 0-1: 具体性
  actionability: number;            // 0-1: 実行可能性
  timestamp: Date;
}

export type FeedbackType = 
  | 'positive' | 'constructive' | 'corrective' | 'preference'
  | 'suggestion' | 'complaint' | 'praise' | 'request';

export interface ImplicitFeedback {
  signal: string;
  interpretation: string;
  confidence: number;               // 0-1: 解釈信頼度
  impact: number;                   // 0-1: 影響度
  pattern: boolean;                 // パターンの一部か
}

export interface BehavioralFeedback {
  behavior: string;
  frequency: number;                // 0-1: 頻度
  context: string[];
  implications: string[];
  adaptation_suggestions: string[];
}

export type IntegrationStrategy = 
  | 'immediate' | 'batch' | 'weighted' | 'experimental' | 'conservative';

export type ValidationMethod = 
  | 'a_b_testing' | 'satisfaction_inquiry' | 'behavior_monitoring'
  | 'outcome_measurement' | 'peer_comparison' | 'self_reflection';

export interface MetaAnalysis {
  confidence: AnalysisConfidence;
  quality: AnalysisQuality;
  completeness: AnalysisCompleteness;
  
  // 分析の限界
  limitations: AnalysisLimitation[];
  uncertainties: AnalysisUncertainty[];
  
  // 改善提案
  improvements: AnalysisImprovement[];
}

export interface AnalysisConfidence {
  overall: number;                  // 0-1: 全体信頼度
  components: { [component: string]: number }; // コンポーネント別信頼度
  factors: ConfidenceFactor[];
}

export interface ConfidenceFactor {
  factor: string;
  impact: number;                   // -1 to 1: 信頼度への影響
  controllability: number;          // 0-1: 制御可能性
}

export interface AnalysisQuality {
  dataQuality: number;              // 0-1: データ品質
  methodQuality: number;            // 0-1: 手法品質
  interpretationQuality: number;    // 0-1: 解釈品質
  
  // 品質要因
  strengthens: QualityFactor[];
  weaknesses: QualityFactor[];
}

export interface QualityFactor {
  factor: string;
  significance: number;             // 0-1: 重要度
  improvement_potential: number;    // 0-1: 改善可能性
}

export interface AnalysisCompleteness {
  coverage: number;                 // 0-1: カバレッジ
  missing_aspects: string[];
  depth: number;                    // 0-1: 深度
  breadth: number;                  // 0-1: 幅
}

export interface AnalysisLimitation {
  limitation: string;
  type: LimitationType;
  severity: number;                 // 0-1: 深刻度
  workarounds: string[];
  future_resolution: string[];
}

export type LimitationType = 
  | 'data_limitation' | 'method_limitation' | 'context_limitation'
  | 'time_limitation' | 'resource_limitation' | 'knowledge_limitation';

export interface AnalysisUncertainty {
  aspect: string;
  uncertainty_level: number;        // 0-1: 不確実性レベル
  source: UncertaintySource;
  impact: number;                   // 0-1: 分析への影響
  resolution_approaches: string[];
}

export type UncertaintySource = 
  | 'insufficient_data' | 'ambiguous_data' | 'conflicting_data'
  | 'methodological' | 'interpretive' | 'contextual';

export interface AnalysisImprovement {
  improvement: string;
  type: ImprovementType;
  potential_benefit: number;        // 0-1: 潜在的効果
  implementation_difficulty: number; // 0-1: 実装困難度
  priority: number;                 // 0-1: 優先度
}

export type ImprovementType = 
  | 'data_enhancement' | 'method_refinement' | 'tool_upgrade'
  | 'training_improvement' | 'process_optimization' | 'integration_enhancement';

// =============================================================================
// Predictive Analytics Types
// =============================================================================

export interface Prediction {
  id: string;
  type: PredictionType;
  target: string;                   // 予測対象
  confidence: number;               // 0-1: 予測信頼度
  timeFrame: TimeFrame;
  
  // 予測内容
  prediction: PredictionContent;
  
  // 根拠情報
  evidence: Evidence[];
  methodology: PredictionMethodology;
  
  // 検証情報
  validation: PredictionValidation;
}

export type PredictionType = 
  | 'behavior' | 'preference' | 'need' | 'emotion'
  | 'performance' | 'satisfaction' | 'engagement' | 'growth';

export interface TimeFrame {
  horizon: TimeHorizon;
  specific_time?: Date;
  duration?: number;                // 分単位
  recurrence?: RecurrencePattern;
}

export type TimeHorizon = 'immediate' | 'short_term' | 'medium_term' | 'long_term';

export interface RecurrencePattern {
  type: RecurrenceType;
  frequency: number;
  pattern: string;
}

export type RecurrenceType = 'none' | 'regular' | 'seasonal' | 'event_driven' | 'irregular';

export interface PredictionContent {
  mainPrediction: string;
  alternatives: AlternativePrediction[];
  probability: number;              // 0-1: 発生確率
  impact: number;                   // 0-1: 影響度
  
  // 条件依存性
  conditions: PredictionCondition[];
  modifiers: PredictionModifier[];
}

export interface AlternativePrediction {
  prediction: string;
  probability: number;              // 0-1: 発生確率
  conditions: string[];
}

export interface PredictionCondition {
  condition: string;
  type: ConditionType;
  likelihood: number;               // 0-1: 条件成立可能性
  impact_on_prediction: number;     // -1 to 1: 予測への影響
}

export type ConditionType = 'enabling' | 'inhibiting' | 'modifying' | 'triggering';

export interface PredictionModifier {
  modifier: string;
  effect: ModifierEffect;
  magnitude: number;                // 0-1: 効果の大きさ
  controllability: number;          // 0-1: 制御可能性
}

export type ModifierEffect = 'amplifying' | 'dampening' | 'accelerating' | 'delaying' | 'redirecting';

export interface Evidence {
  source: EvidenceSource;
  content: string;
  weight: number;                   // 0-1: 証拠の重み
  reliability: number;              // 0-1: 信頼性
  recency: number;                  // 0-1: 新しさ
  relevance: number;                // 0-1: 関連性
}

export type EvidenceSource = 
  | 'historical_pattern' | 'stated_preference' | 'behavioral_trend'
  | 'contextual_factor' | 'external_indicator' | 'analytical_model';

export interface PredictionMethodology {
  primaryMethod: PredictionMethod;
  supportingMethods: PredictionMethod[];
  dataInputs: DataInput[];
  assumptions: Assumption[];
  
  // 手法の特性
  accuracy: number;                 // 0-1: 手法精度
  interpretability: number;         // 0-1: 解釈しやすさ
  robustness: number;              // 0-1: 頑健性
}

export type PredictionMethod = 
  | 'pattern_recognition' | 'statistical_model' | 'machine_learning'
  | 'rule_based' | 'hybrid' | 'ensemble' | 'heuristic';

export interface DataInput {
  source: string;
  type: DataType;
  quality: number;                  // 0-1: データ品質
  coverage: number;                 // 0-1: カバレッジ
  recency: number;                  // 0-1: 新しさ
}

export type DataType = 
  | 'behavioral' | 'preferential' | 'contextual' | 'temporal'
  | 'relational' | 'emotional' | 'cognitive' | 'environmental';

export interface Assumption {
  assumption: string;
  criticality: number;              // 0-1: 重要度
  validity: number;                 // 0-1: 妥当性
  testability: number;              // 0-1: 検証可能性
  impact_if_violated: number;       // 0-1: 違反時の影響
}

export interface PredictionValidation {
  method: ValidationMethod[];
  criteria: ValidationCriteria;
  schedule: ValidationSchedule;
  
  // 結果追跡
  tracking: PredictionTracking;
  feedback_loop: FeedbackLoop;
}

export interface ValidationCriteria {
  accuracy_threshold: number;       // 0-1: 精度閾値
  timing_tolerance: number;         // 時間的許容度（分）
  qualitative_markers: string[];
  success_indicators: string[];
}

export interface ValidationSchedule {
  checkpoints: ValidationCheckpoint[];
  continuous_monitoring: boolean;
  adaptation_triggers: string[];
}

export interface ValidationCheckpoint {
  time: Date;
  type: CheckpointType;
  criteria: string[];
  actions: string[];
}

export type CheckpointType = 'scheduled' | 'milestone' | 'triggered' | 'ad_hoc';

export interface PredictionTracking {
  metrics: TrackingMetric[];
  frequency: TrackingFrequency;
  storage: TrackingStorage;
  alerts: TrackingAlert[];
}

export interface TrackingMetric {
  metric: string;
  type: MetricType;
  target_value: number;
  current_value?: number;
  trend: MetricTrend;
}

export type MetricType = 'accuracy' | 'precision' | 'recall' | 'timing' | 'satisfaction' | 'adoption';
export type MetricTrend = 'improving' | 'stable' | 'declining' | 'volatile' | 'unknown';

export type TrackingFrequency = 'continuous' | 'hourly' | 'daily' | 'weekly' | 'event_based';

export interface TrackingStorage {
  retention_period: number;         // 日単位
  aggregation_level: AggregationLevel;
  privacy_level: PrivacyLevel;
}

export type AggregationLevel = 'raw' | 'summary' | 'statistical' | 'anonymized';

export interface TrackingAlert {
  condition: string;
  urgency: AlertUrgency;
  action: string[];
  recipients: string[];
}

export type AlertUrgency = 'low' | 'medium' | 'high' | 'critical';

export interface FeedbackLoop {
  type: FeedbackLoopType;
  frequency: FeedbackFrequency;
  improvement_strategy: ImprovementStrategy;
  learning_mechanism: LearningMechanism;
}

export type FeedbackLoopType = 'reactive' | 'proactive' | 'adaptive' | 'predictive';
export type FeedbackFrequency = 'immediate' | 'batch' | 'periodic' | 'on_demand';

export interface ImprovementStrategy {
  approach: ImprovementApproach;
  priorities: string[];
  constraints: string[];
  success_metrics: string[];
}

export type ImprovementApproach = 
  | 'incremental' | 'revolutionary' | 'experimental' | 'conservative' | 'aggressive';

export interface LearningMechanism {
  type: LearningType;
  adaptation_rate: number;          // 0-1: 適応速度
  retention: LearningRetention;
  transfer: LearningTransfer;
}

export type LearningType = 'supervised' | 'unsupervised' | 'reinforcement' | 'transfer' | 'meta';

export interface LearningRetention {
  duration: number;                 // 日単位
  decay_pattern: DecayPattern;
  reinforcement_strategy: string[];
}

export type DecayPattern = 'exponential' | 'linear' | 'power_law' | 'step' | 'none';

export interface LearningTransfer {
  scope: TransferScope;
  method: TransferMethod;
  validation: TransferValidation;
}

export type TransferScope = 'same_user' | 'similar_users' | 'domain_specific' | 'general' | 'none';
export type TransferMethod = 'direct' | 'analogical' | 'abstraction' | 'similarity' | 'causal';
export type TransferValidation = 'immediate' | 'delayed' | 'continuous' | 'sampled' | 'none';

// =============================================================================
// System Configuration Types
// =============================================================================

export interface PersonalizationConfig {
  // 機能有効性
  enabled: boolean;
  features: FeatureConfig;
  
  // パフォーマンス設定
  performance: PerformanceConfig;
  
  // プライバシー設定
  privacy: PrivacyConfig;
  
  // 品質設定
  quality: QualityConfig;
  
  // 学習設定
  learning: LearningConfig;
}

export interface FeatureConfig {
  dynamicProfiling: boolean;
  predictiveAnalytics: boolean;
  memoryManagement: boolean;
  relationshipTracking: boolean;
  emotionalIntelligence: boolean;
  learningSupport: boolean;
  contextAwareness: boolean;
  adaptiveResponse: boolean;
}

export interface PerformanceConfig {
  maxConcurrentUsers: number;
  cacheSize: number;                // MB
  analysisTimeout: number;          // 秒
  memoryCleanupInterval: number;    // 時間
  predictionBatchSize: number;
  backgroundProcessing: boolean;
}

export interface PrivacyConfig {
  dataRetention: DataRetentionConfig;
  anonymization: AnonymizationConfig;
  userControl: UserControlConfig;
  compliance: ComplianceConfig;
}

export interface DataRetentionConfig {
  defaultRetention: number;         // 日
  categorySpecific: { [category: string]: number };
  userOverridable: boolean;
  automaticCleanup: boolean;
}

export interface AnonymizationConfig {
  autoAnonymize: boolean;
  threshold: number;                // 日
  methods: AnonymizationMethod[];
  reversibility: boolean;
}

export type AnonymizationMethod = 'pseudonymization' | 'generalization' | 'suppression' | 'perturbation';

export interface UserControlConfig {
  memoryAccess: boolean;
  memoryEdit: boolean;
  memoryDelete: boolean;
  profileDownload: boolean;
  consentGranularity: ConsentLevel;
}

export type ConsentLevel = 'all_or_nothing' | 'category_level' | 'feature_level' | 'granular';

export interface ComplianceConfig {
  gdprCompliant: boolean;
  ccpaCompliant: boolean;
  additionalRegulations: string[];
  auditLogging: boolean;
}

export interface QualityConfig {
  minConfidenceThreshold: number;   // 0-1
  validationStrategies: ValidationMethod[];
  qualityMetrics: QualityMetric[];
  feedbackIntegration: boolean;
}

export interface QualityMetric {
  metric: string;
  target: number;
  tolerance: number;
  measurement: MeasurementMethod;
}

export type MeasurementMethod = 'automatic' | 'user_feedback' | 'expert_review' | 'a_b_testing';

export interface LearningConfig {
  adaptationRate: number;           // 0-1
  forgettingEnabled: boolean;
  crossUserLearning: boolean;
  experimentalFeatures: boolean;
  modelUpdateFrequency: UpdateFrequency;
}

export type UpdateFrequency = 'real_time' | 'hourly' | 'daily' | 'weekly' | 'manual';

// =============================================================================
// API and Integration Types
// =============================================================================

export interface PersonalizationAPI {
  // プロファイル操作
  getProfile(userId: string): Promise<DynamicUserProfile>;
  updateProfile(userId: string, updates: Partial<DynamicUserProfile>): Promise<void>;
  resetProfile(userId: string): Promise<void>;
  
  // メモリ操作
  getMemories(userId: string, query: any): Promise<any>;
  addMemory(userId: string, memory: Partial<MemoryEntry>): Promise<MemoryEntry>;
  updateMemory(memoryId: string, updates: Partial<MemoryEntry>): Promise<void>;
  deleteMemory(memoryId: string): Promise<void>;
  
  // 分析機能
  analyzeConversation(content: string, context: AnalysisContext): Promise<ConversationAnalysis>;
  generatePredictions(userId: string, context: PredictionContext): Promise<Prediction[]>;
  
  // パーソナライゼーション
  personalizeResponse(
    response: string,
    userId: string,
    context: PersonalizationContext
  ): Promise<string>;
  
  // システム管理
  getSystemStatus(): Promise<SystemStatus>;
  performMaintenance(operations: MaintenanceOperation[]): Promise<MaintenanceResult>;
}

export interface AnalysisContext {
  sessionId: string;
  previousMessages: string[];
  userProfile: DynamicUserProfile;
  timestamp: Date;
  metadata: ContextMetadata;
}

export interface ContextMetadata {
  source: string;
  channel: string;
  device: string;
  location?: GeoLocation;
  environment: EnvironmentContext;
}

export interface GeoLocation {
  latitude: number;
  longitude: number;
  accuracy: number;                 // メートル
  timezone: string;
}

export interface EnvironmentContext {
  timeOfDay: TimeOfDay;
  dayOfWeek: DayOfWeek;
  season: Season;
  contextualFactors: string[];
}

export type TimeOfDay = 'early_morning' | 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' | 'late_night';
export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export interface PredictionContext {
  targetDomain: string[];
  timeHorizon: TimeHorizon;
  confidenceThreshold: number;      // 0-1
  maxPredictions: number;
}

export interface PersonalizationContext {
  responseType: ResponseType;
  urgency: ResponseUrgency;
  audience: ResponseAudience;
  constraints: ResponseConstraint[];
}

export type ResponseUrgency = 'low' | 'normal' | 'high' | 'critical';
export type ResponseAudience = 'individual' | 'group' | 'public' | 'professional';

export interface ResponseConstraint {
  type: ConstraintType;
  value: string | number;
  flexibility: number;              // 0-1: 制約の柔軟性
}

export type ConstraintType = 
  | 'length' | 'tone' | 'formality' | 'complexity'
  | 'topic_focus' | 'time_limit' | 'privacy_level';

export interface SystemStatus {
  overall: SystemHealth;
  components: ComponentStatus[];
  performance: PerformanceMetrics;
  alerts: SystemAlert[];
}

export type SystemHealth = 'healthy' | 'warning' | 'critical' | 'degraded' | 'offline';

export interface ComponentStatus {
  component: string;
  status: SystemHealth;
  lastCheck: Date;
  metrics: { [metric: string]: number };
  issues: string[];
}

export interface PerformanceMetrics {
  responseTime: number;             // ミリ秒
  throughput: number;               // リクエスト/秒
  errorRate: number;                // 0-1
  resourceUtilization: ResourceUtilization;
}

export interface ResourceUtilization {
  cpu: number;                      // 0-1
  memory: number;                   // 0-1
  storage: number;                  // 0-1
  network: number;                  // 0-1
}

export interface SystemAlert {
  id: string;
  level: AlertLevel;
  component: string;
  message: string;
  timestamp: Date;
  acknowledged: boolean;
}

export type AlertLevel = 'info' | 'warning' | 'error' | 'critical';

export interface MaintenanceOperation {
  type: MaintenanceType;
  target: string;
  parameters: { [key: string]: any };
  schedule: MaintenanceSchedule;
}

export type MaintenanceType = 
  | 'data_cleanup' | 'index_rebuild' | 'cache_clear'
  | 'model_update' | 'backup' | 'validation' | 'optimization';

export interface MaintenanceSchedule {
  immediate: boolean;
  scheduledTime?: Date;
  estimatedDuration: number;        // 分
  priority: MaintenancePriority;
}

export type MaintenancePriority = 'low' | 'normal' | 'high' | 'emergency';

export interface MaintenanceResult {
  operationId: string;
  status: OperationStatus;
  startTime: Date;
  endTime?: Date;
  results: OperationResult[];
  errors: OperationError[];
}

export type OperationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface OperationResult {
  metric: string;
  before: number;
  after: number;
  improvement: number;              // 改善度
}

export interface OperationError {
  code: string;
  message: string;
  severity: ErrorSeverity;
  recoverable: boolean;
}

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

// =============================================================================
// Utility Types
// =============================================================================

export interface EmotionalChange {
  fromEmotion: EmotionType;
  toEmotion: EmotionType;
  timestamp: Date;
  trigger?: string;
  intensity: number;                // 0-1: 変化の強度
}

export interface ProfileMetadata {
  createdAt: Date;
  lastUpdated: Date;
  version: number;
  interactionCount: number;
  dataConfidence: number;           // 0-1: プロファイル信頼度
  
  // プライバシー設定
  privacySettings: PrivacySettings;
  
  // 同意管理
  consent: ConsentRecord;
  
  // 品質情報
  qualityScore: number;             // 0-1: プロファイル品質
  completeness: number;             // 0-1: プロファイル完成度
}

export interface PrivacySettings {
  dataSharing: DataSharingLevel;
  retention: RetentionPreference;
  anonymization: AnonymizationPreference;
  access: AccessControl;
}

export type DataSharingLevel = 'none' | 'anonymous' | 'aggregated' | 'limited' | 'full';

export interface RetentionPreference {
  general: number;                  // 日数
  sensitive: number;                // 日数
  override: { [category: string]: number };
}

export interface AnonymizationPreference {
  automatic: boolean;
  threshold: number;                // 日数
  method: AnonymizationMethod;
  reversible: boolean;
}

export interface AccessControl {
  selfAccess: boolean;
  thirdPartyAccess: boolean;
  auditAccess: boolean;
  researchAccess: boolean;
}

export interface ConsentRecord {
  given: Date;
  version: string;
  granular: { [feature: string]: boolean };
  withdrawn?: Date;
  modifications: ConsentModification[];
}

export interface ConsentModification {
  timestamp: Date;
  changes: { [feature: string]: boolean };
  reason?: string;
}