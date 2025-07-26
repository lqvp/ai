/**
 * Dynamic Profile Manager - Advanced User Profiling System
 * 
 * Real-time user characteristic inference and relationship development tracking
 * Implements sophisticated personality analysis, behavioral pattern recognition,
 * and adaptive relationship management
 */

import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { bindThis } from '@/decorators.js';
import {
  DynamicUserProfile,
  PersonalityTraits,
  CommunicationPreferences,
  RelationshipState,
  Interest,
  ExpertiseArea,
  Goal,
  BehaviorPatterns,
  LearningJourney,
  ConversationAnalysis,
  RelationshipStage,
  InterestCategory,
  ExpertiseLevel,
  GoalType,
  GoalStatus,
  SkillCategory,
  SkillLevel,
  EmotionType,
  QuestionType,
  LearningStyle,
  ResponseLengthPreference,
  ReactionStyle,
  VocabularyLevel,
  QuestioningStyle,
  FeedbackPreference,
  ConflictResolutionStyle,
  ConflictEvent,
  RelationshipMilestone,
  MilestoneType,
  ProfileMetadata,
  PrivacySettings,
  ConsentRecord
} from '../types.js';
import HybridMemorySystem from './HybridMemorySystem.js';

interface ProfileUpdateContext {
  messageContent: string;
  analysis: ConversationAnalysis;
  sessionId: string;
  timestamp: Date;
  interactionCount: number;
}

interface PersonalityInference {
  trait: keyof PersonalityTraits;
  evidence: string[];
  confidence: number;
  previousValue: number;
  newValue: number;
  rationale: string;
}

interface BehaviorObservation {
  type: 'communication' | 'learning' | 'emotional' | 'decision_making';
  observation: string;
  evidence: any;
  timestamp: Date;
  confidence: number;
}

interface RelationshipProgression {
  previousStage: RelationshipStage;
  newStage: RelationshipStage;
  triggers: string[];
  evidence: string[];
  confidence: number;
  progression_speed: number;
}

export class DynamicProfileManager extends EventEmitter {
  private memorySystem: HybridMemorySystem;
  private profiles: Map<string, DynamicUserProfile>;
  private profileUpdateThreshold: number = 0.1; // Minimum confidence to update profile
  private relationshipProgressionThreshold: number = 0.7; // Minimum confidence for stage progression
  private personalityStabilityFactor: number = 0.05; // How much personality can change per interaction
  private maxInterestCount: number = 50; // Maximum interests per user
  private maxExpertiseCount: number = 20; // Maximum expertise areas per user

  constructor(memorySystem: HybridMemorySystem) {
    super();
    this.memorySystem = memorySystem;
    this.profiles = new Map();
  }

  // =====================================================================
  // Profile Management
  // =====================================================================

  @bindThis
  async getOrCreateProfile(userId: string): Promise<DynamicUserProfile> {
    if (this.profiles.has(userId)) {
      return this.profiles.get(userId)!;
    }

    // Try to load from persistent storage
    const savedProfile = await this.loadProfileFromStorage(userId);
    if (savedProfile) {
      this.profiles.set(userId, savedProfile);
      return savedProfile;
    }

    // Create new profile
    const newProfile = this.createInitialProfile(userId);
    this.profiles.set(userId, newProfile);
    await this.saveProfileToStorage(newProfile);
    
    this.emit('profile_created', { userId, profile: newProfile });
    return newProfile;
  }

  @bindThis
  private createInitialProfile(userId: string): DynamicUserProfile {
    const now = new Date();
    
    return {
      userId,
      displayName: undefined,
      preferredName: undefined,
      avatarUrl: undefined,
      
      personality: {
        openness: 0.5,
        conscientiousness: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        neuroticism: 0.5,
        curiosity: 0.5,
        humor: 0.5,
        technicalApproach: 0.5,
        creativity: 0.5,
        patience: 0.5,
        detail_orientation: 0.5,
        confidence: {
          openness: 0.1,
          conscientiousness: 0.1,
          extraversion: 0.1,
          agreeableness: 0.1,
          neuroticism: 0.1,
          curiosity: 0.1,
          humor: 0.1,
          technicalApproach: 0.1,
          creativity: 0.1,
          patience: 0.1,
          detail_orientation: 0.1
        },
        lastUpdated: now
      },
      
      communication: {
        preferredFormality: 0.5,
        emotionalExpression: 0.5,
        responseLength: 'adaptive',
        emojiUsage: 0.3,
        reactionStyle: 'thoughtful',
        vocabularyLevel: 'intermediate',
        technicalTermUsage: 0.3,
        questioningStyle: 'gentle',
        feedbackPreference: 'constructive',
        conflictResolution: 'collaborative'
      },
      
      relationshipLevel: {
        stage: 'stranger',
        trustLevel: 0.1,
        intimacyLevel: 0.1,
        sharedExperiences: 0,
        conflictHistory: [],
        milestones: [],
        communicationQuality: 0.5,
        mutualUnderstanding: 0.1,
        emotionalConnection: 0.1,
        progressionRate: 0.1,
        plateauRisk: 0.8,
        lastSignificantInteraction: now
      },
      
      interests: [],
      expertise: [],
      goals: [],
      
      behaviorPatterns: {
        activeHours: [],
        sessionPatterns: [],
        responsePatterns: [],
        questionTypes: [],
        topicTransitions: [],
        learningBehavior: {
          preferredLearningStyle: ['reading'],
          attentionSpan: 30,
          repetitionNeeds: 0.5,
          feedbackSensitivity: 0.5,
          experimentationTendency: 0.5
        },
        helpSeekingBehavior: {
          frequency: 0.3,
          specificity: 0.5,
          persistenceLevel: 0.5,
          preferredSupportType: ['information'],
          autonomyLevel: 0.7
        },
        emotionalPatterns: [],
        decisionMakingStyle: {
          analyticalVsIntuitive: 0.5,
          quickVsDeliberate: 0.5,
          independentVsCollaborative: 0.5,
          riskTolerance: 0.5,
          informationNeed: 0.7
        }
      },
      
      learningJourney: {
        skillsAcquired: [],
        progressMarkers: [],
        challengesFaced: [],
        achievements: [],
        learningMilestones: [],
        overallProgress: 0.1,
        learningVelocity: 0.3,
        retentionRate: 0.7,
        applicationRate: 0.5
      },
      
      metadata: {
        createdAt: now,
        lastUpdated: now,
        version: 1,
        interactionCount: 0,
        dataConfidence: 0.1,
        privacySettings: this.createDefaultPrivacySettings(),
        consent: this.createDefaultConsent(now),
        qualityScore: 0.3,
        completeness: 0.1
      }
    };
  }

  @bindThis
  private createDefaultPrivacySettings(): PrivacySettings {
    return {
      dataSharing: 'none',
      retention: {
        general: 365, // 1 year
        sensitive: 90, // 3 months
        override: {}
      },
      anonymization: {
        automatic: true,
        threshold: 30,
        method: 'pseudonymization',
        reversible: false
      },
      access: {
        selfAccess: true,
        thirdPartyAccess: false,
        auditAccess: true,
        researchAccess: false
      }
    };
  }

  @bindThis
  private createDefaultConsent(timestamp: Date): ConsentRecord {
    return {
      given: timestamp,
      version: '1.0',
      granular: {
        basic_profiling: true,
        behavior_analysis: true,
        relationship_tracking: true,
        predictive_analytics: false,
        cross_user_learning: false
      },
      withdrawn: undefined,
      modifications: []
    };
  }

  // =====================================================================
  // Profile Update Logic
  // =====================================================================

  @bindThis
  async updateProfile(
    userId: string,
    messageContent: string,
    analysis: ConversationAnalysis,
    sessionId: string
  ): Promise<void> {
    const profile = await this.getOrCreateProfile(userId);
    const context: ProfileUpdateContext = {
      messageContent,
      analysis,
      sessionId,
      timestamp: new Date(),
      interactionCount: profile.metadata.interactionCount + 1
    };

    // Update interaction metadata
    profile.metadata.interactionCount = context.interactionCount;
    profile.metadata.lastUpdated = context.timestamp;

    // Perform comprehensive profile updates
    await Promise.all([
      this.updatePersonality(profile, context),
      this.updateCommunicationPreferences(profile, context),
      this.updateRelationshipLevel(profile, context),
      this.updateInterests(profile, context),
      this.updateExpertise(profile, context),
      this.updateBehaviorPatterns(profile, context),
      this.updateLearningJourney(profile, context)
    ]);

    // Calculate overall profile confidence and completeness
    this.calculateProfileMetrics(profile);

    // Save updated profile
    await this.saveProfileToStorage(profile);
    this.emit('profile_updated', { userId, profile, context });
  }

  // =====================================================================
  // Personality Analysis and Updates
  // =====================================================================

  @bindThis
  private async updatePersonality(
    profile: DynamicUserProfile,
    context: ProfileUpdateContext
  ): Promise<void> {
    const inferences = await this.inferPersonalityTraits(context);
    
    for (const inference of inferences) {
      if (inference.confidence >= this.profileUpdateThreshold) {
        // Apply gradual personality adjustment with stability factor
        const currentValue = profile.personality[inference.trait] as number;
        const adjustment = (inference.newValue - currentValue) * 
                          this.personalityStabilityFactor * 
                          inference.confidence;
        
        const newValue = Math.max(0, Math.min(1, currentValue + adjustment));
        
        // Update trait value and confidence
        (profile.personality as any)[inference.trait] = newValue;
        profile.personality.confidence[inference.trait] = Math.min(1, 
          profile.personality.confidence[inference.trait] + inference.confidence * 0.1
        );

        this.emit('personality_updated', {
          userId: profile.userId,
          trait: inference.trait,
          oldValue: currentValue,
          newValue,
          evidence: inference.evidence,
          confidence: inference.confidence
        });
      }
    }

    profile.personality.lastUpdated = context.timestamp;
  }

  @bindThis
  private async inferPersonalityTraits(context: ProfileUpdateContext): Promise<PersonalityInference[]> {
    const inferences: PersonalityInference[] = [];
    const { analysis, messageContent } = context;

    // Analyze openness from creative expressions and new concepts
    if (analysis.topic.novelty > 0.7 || analysis.learning?.learningOpportunity.type === 'creative_exploration') {
      inferences.push({
        trait: 'openness',
        evidence: [`Engaged with novel topic: ${analysis.topic.mainTopic}`, 'Showed interest in creative exploration'],
        confidence: analysis.topic.novelty * 0.8,
        previousValue: 0, // Will be set in updatePersonality
        newValue: 0.7,
        rationale: 'Demonstrated openness to new experiences and creative thinking'
      });
    }

    // Analyze conscientiousness from planning and detail-oriented behavior
    if (analysis.intent.primaryIntent === 'planning' || 
        messageContent.includes('plan') || messageContent.includes('organize')) {
      inferences.push({
        trait: 'conscientiousness',
        evidence: ['Showed planning behavior', 'Detail-oriented communication'],
        confidence: 0.6,
        previousValue: 0,
        newValue: 0.7,
        rationale: 'Demonstrated organized thinking and planning behavior'
      });
    }

    // Analyze extraversion from communication style and social cues
    const communicationLength = messageContent.length;
    const questionCount = (messageContent.match(/\?/g) || []).length;
    if (communicationLength > 200 && questionCount > 2) {
      inferences.push({
        trait: 'extraversion',
        evidence: ['Long, interactive communication', `${questionCount} questions asked`],
        confidence: 0.5,
        previousValue: 0,
        newValue: 0.6,
        rationale: 'Verbose and interactive communication style suggests extraversion'
      });
    }

    // Analyze agreeableness from emotional support and collaborative language
    if (analysis.emotion.regulationNeeds.some(need => need.need === 'support') ||
        messageContent.includes('agree') || messageContent.includes('understand')) {
      inferences.push({
        trait: 'agreeableness',
        evidence: ['Supportive language', 'Agreement-seeking behavior'],
        confidence: 0.6,
        previousValue: 0,
        newValue: 0.7,
        rationale: 'Demonstrated supportive and agreement-seeking behavior'
      });
    }

    // Analyze neuroticism from emotional volatility
    if (analysis.emotion.emotionalStability < 0.5 || analysis.emotion.emotionIntensity > 0.8) {
      inferences.push({
        trait: 'neuroticism',
        evidence: ['High emotional intensity', 'Lower emotional stability'],
        confidence: (1 - analysis.emotion.emotionalStability) * 0.8,
        previousValue: 0,
        newValue: 0.6,
        rationale: 'Emotional volatility suggests higher neuroticism'
      });
    }

    // Analyze curiosity from question patterns and learning engagement
    if (analysis.learning?.learningOpportunity.value > 0.7 || questionCount > 3) {
      inferences.push({
        trait: 'curiosity',
        evidence: ['High learning engagement', 'Multiple questions asked'],
        confidence: Math.min(analysis.learning?.learningOpportunity.value || 0.5, 0.8),
        previousValue: 0,
        newValue: 0.8,
        rationale: 'Strong questioning and learning behavior indicates high curiosity'
      });
    }

    // Analyze humor from emotional tone and playful language
    if (analysis.personalization.responseStyle.tone === 'playful' ||
        messageContent.includes('😂') || messageContent.includes('lol') || messageContent.includes('haha')) {
      inferences.push({
        trait: 'humor',
        evidence: ['Playful tone', 'Humor markers in text'],
        confidence: 0.7,
        previousValue: 0,
        newValue: 0.7,
        rationale: 'Use of humor and playful language indicates appreciation for humor'
      });
    }

    // Analyze technical approach from domain expertise and terminology
    if (analysis.topic.topicCategory === 'technical' || 
        analysis.topic.expertise_required > 0.6) {
      inferences.push({
        trait: 'technicalApproach',
        evidence: ['Technical topic engagement', 'Complex concept discussion'],
        confidence: analysis.topic.expertise_required * 0.8,
        previousValue: 0,
        newValue: 0.7,
        rationale: 'Engagement with technical topics suggests technical orientation'
      });
    }

    return inferences;
  }

  // =====================================================================
  // Communication Preferences
  // =====================================================================

  @bindThis
  private async updateCommunicationPreferences(
    profile: DynamicUserProfile,
    context: ProfileUpdateContext
  ): Promise<void> {
    const { analysis, messageContent } = context;
    
    // Update formality based on language style
    const formalIndicators = messageContent.match(/\b(please|thank you|could you|would you|sir|madam)\b/gi) || [];
    const informalIndicators = messageContent.match(/\b(hey|yeah|ok|cool|awesome|lol)\b/gi) || [];
    
    if (formalIndicators.length > informalIndicators.length) {
      profile.communication.preferredFormality = Math.min(1, 
        profile.communication.preferredFormality + 0.1
      );
    } else if (informalIndicators.length > formalIndicators.length) {
      profile.communication.preferredFormality = Math.max(0, 
        profile.communication.preferredFormality - 0.1
      );
    }

    // Update emotional expression based on sentiment and emotion analysis
    if (analysis.emotion.emotionIntensity > 0.7) {
      profile.communication.emotionalExpression = Math.min(1,
        profile.communication.emotionalExpression + 0.1
      );
    }

    // Update emoji usage based on message content
    const emojiCount = (messageContent.match(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/gu) || []).length;
    if (emojiCount > 0) {
      const emojiRatio = emojiCount / Math.max(1, messageContent.split(' ').length);
      profile.communication.emojiUsage = Math.min(1,
        profile.communication.emojiUsage + emojiRatio * 0.5
      );
    }

    // Update response length preference based on message characteristics
    const wordCount = messageContent.split(' ').length;
    if (wordCount > 100) {
      profile.communication.responseLength = 'detailed';
    } else if (wordCount < 20) {
      profile.communication.responseLength = 'brief';
    } else {
      profile.communication.responseLength = 'moderate';
    }

    // Update vocabulary level based on complexity
    if (analysis.topic.complexity > 0.7) {
      if (profile.communication.vocabularyLevel === 'simple') {
        profile.communication.vocabularyLevel = 'intermediate';
      } else if (profile.communication.vocabularyLevel === 'intermediate') {
        profile.communication.vocabularyLevel = 'advanced';
      }
    }

    // Update questioning style based on question patterns
    const questionCount = (messageContent.match(/\?/g) || []).length;
    if (questionCount > 3) {
      profile.communication.questioningStyle = 'direct';
    } else if (messageContent.includes('perhaps') || messageContent.includes('maybe')) {
      profile.communication.questioningStyle = 'gentle';
    }
  }

  // =====================================================================
  // Relationship Development
  // =====================================================================

  @bindThis
  private async updateRelationshipLevel(
    profile: DynamicUserProfile,
    context: ProfileUpdateContext
  ): Promise<void> {
    const { analysis } = context;
    const currentStage = profile.relationshipLevel.stage;
    
    // Update basic relationship metrics
    profile.relationshipLevel.sharedExperiences += 1;
    
    // Update trust level based on interaction quality
    if (analysis.relationship.communicationQuality.authenticity > 0.7) {
      profile.relationshipLevel.trustLevel = Math.min(1,
        profile.relationshipLevel.trustLevel + 0.05
      );
    }

    // Update intimacy level based on personal disclosure and emotional connection
    if (analysis.topic.topicCategory === 'personal' || 
        analysis.emotion.emotionIntensity > 0.6) {
      profile.relationshipLevel.intimacyLevel = Math.min(1,
        profile.relationshipLevel.intimacyLevel + 0.03
      );
    }

    // Check for relationship stage progression
    const progressionAnalysis = this.analyzeRelationshipProgression(profile, analysis);
    if (progressionAnalysis.confidence >= this.relationshipProgressionThreshold) {
      await this.progressRelationshipStage(profile, progressionAnalysis, context);
    }

    // Update communication quality metrics
    profile.relationshipLevel.communicationQuality = Math.min(1,
      profile.relationshipLevel.communicationQuality + 
      analysis.relationship.communicationQuality.clarity * 0.02
    );

    // Update mutual understanding
    if (analysis.meta.confidence.overall > 0.7) {
      profile.relationshipLevel.mutualUnderstanding = Math.min(1,
        profile.relationshipLevel.mutualUnderstanding + 0.03
      );
    }

    // Update emotional connection
    if (analysis.emotion.emotionIntensity > 0.5 && 
        analysis.emotion.sentiment.polarity > 0) {
      profile.relationshipLevel.emotionalConnection = Math.min(1,
        profile.relationshipLevel.emotionalConnection + 0.02
      );
    }

    profile.relationshipLevel.lastSignificantInteraction = context.timestamp;
  }

  @bindThis
  private analyzeRelationshipProgression(
    profile: DynamicUserProfile,
    analysis: ConversationAnalysis
  ): RelationshipProgression {
    const currentStage = profile.relationshipLevel.stage;
    let newStage = currentStage;
    const triggers: string[] = [];
    const evidence: string[] = [];
    let confidence = 0;

    // Define progression criteria for each stage
    const progressionCriteria = {
      stranger: {
        to: 'acquaintance' as RelationshipStage,
        requirements: {
          minInteractions: 3,
          minTrust: 0.2,
          personalTopics: false
        }
      },
      acquaintance: {
        to: 'friend' as RelationshipStage,
        requirements: {
          minInteractions: 10,
          minTrust: 0.4,
          minIntimacy: 0.3,
          personalTopics: true
        }
      },
      friend: {
        to: 'close_friend' as RelationshipStage,
        requirements: {
          minInteractions: 25,
          minTrust: 0.7,
          minIntimacy: 0.6,
          sharedExperiences: 5
        }
      },
      close_friend: {
        to: 'collaborator' as RelationshipStage,
        requirements: {
          minInteractions: 50,
          minTrust: 0.8,
          goalAlignment: true
        }
      }
    };

    const criteria = progressionCriteria[currentStage as keyof typeof progressionCriteria];
    if (criteria) {
      let criteriaeMet = 0;
      let totalCriteria = 0;

      // Check interaction count
      totalCriteria++;
      if (profile.relationshipLevel.sharedExperiences >= criteria.requirements.minInteractions) {
        criteriaeMet++;
        evidence.push(`Met interaction threshold: ${profile.relationshipLevel.sharedExperiences}/${criteria.requirements.minInteractions}`);
      }

      // Check trust level
      if ('minTrust' in criteria.requirements) {
        totalCriteria++;
        if (profile.relationshipLevel.trustLevel >= criteria.requirements.minTrust) {
          criteriaeMet++;
          evidence.push(`Trust level sufficient: ${profile.relationshipLevel.trustLevel.toFixed(2)}/${criteria.requirements.minTrust}`);
        }
      }

      // Check intimacy level
      if ('minIntimacy' in criteria.requirements) {
        totalCriteria++;
        if (profile.relationshipLevel.intimacyLevel >= criteria.requirements.minIntimacy) {
          criteriaeMet++;
          evidence.push(`Intimacy level sufficient: ${profile.relationshipLevel.intimacyLevel.toFixed(2)}/${criteria.requirements.minIntimacy}`);
        }
      }

      // Check personal topic engagement
      if ('personalTopics' in criteria.requirements) {
        totalCriteria++;
        if (analysis.topic.topicCategory === 'personal') {
          criteriaeMet++;
          evidence.push('Engaged in personal topic discussion');
          triggers.push('personal_disclosure');
        }
      }

      confidence = criteriaeMet / totalCriteria;
      
      if (confidence >= this.relationshipProgressionThreshold) {
        newStage = criteria.to;
        triggers.push('progression_criteria_met');
      }
    }

    return {
      previousStage: currentStage,
      newStage,
      triggers,
      evidence,
      confidence,
      progression_speed: confidence * 0.5
    };
  }

  @bindThis
  private async progressRelationshipStage(
    profile: DynamicUserProfile,
    progression: RelationshipProgression,
    context: ProfileUpdateContext
  ): Promise<void> {
    const milestone: RelationshipMilestone = {
      id: uuid(),
      type: this.getRelationshipMilestoneType(progression.newStage),
      timestamp: context.timestamp,
      description: `Relationship progressed from ${progression.previousStage} to ${progression.newStage}`,
      significance: progression.confidence,
      emotionalImpact: 0.7
    };

    profile.relationshipLevel.stage = progression.newStage;
    profile.relationshipLevel.milestones.push(milestone);
    profile.relationshipLevel.progressionRate = progression.progression_speed;

    this.emit('relationship_progressed', {
      userId: profile.userId,
      progression,
      milestone
    });
  }

  @bindThis
  private getRelationshipMilestoneType(stage: RelationshipStage): MilestoneType {
    const stageToMilestone: Record<RelationshipStage, MilestoneType> = {
      stranger: 'first_conversation',
      acquaintance: 'first_conversation',
      friend: 'personal_disclosure',
      close_friend: 'trust_milestone',
      collaborator: 'successful_collaboration',
      mentor_mentee: 'successful_collaboration',
      confidant: 'intimacy_deepening'
    };
    
    return stageToMilestone[stage] || 'first_conversation';
  }

  // =====================================================================
  // Interest and Expertise Tracking
  // =====================================================================

  @bindThis
  private async updateInterests(
    profile: DynamicUserProfile,
    context: ProfileUpdateContext
  ): Promise<void> {
    const { analysis } = context;
    
    // Extract potential interests from topics and entities
    const potentialInterests = [
      analysis.topic.mainTopic,
      ...analysis.topic.subTopics,
      ...analysis.topic.entities.map(e => e.text)
    ].filter(topic => topic && topic.length > 2);

    for (const topic of potentialInterests) {
      await this.updateOrCreateInterest(profile, topic, analysis, context.timestamp);
    }

    // Remove stale interests that haven't been mentioned recently
    this.pruneStaleInterests(profile);
  }

  @bindThis
  private async updateOrCreateInterest(
    profile: DynamicUserProfile,
    topic: string,
    analysis: ConversationAnalysis,
    timestamp: Date
  ): Promise<void> {
    const existingInterest = profile.interests.find(i => 
      i.topic.toLowerCase() === topic.toLowerCase()
    );

    if (existingInterest) {
      // Update existing interest
      existingInterest.lastMentioned = timestamp;
      existingInterest.mentionCount += 1;
      
      // Increase intensity based on engagement
      if (analysis.emotion.emotionIntensity > 0.6 && analysis.emotion.sentiment.polarity > 0) {
        existingInterest.intensity = Math.min(1, existingInterest.intensity + 0.1);
      }
      
      // Update expertise level if user demonstrates knowledge
      if (analysis.topic.expertise_required > 0.7) {
        existingInterest.expertise_level = Math.min(1, existingInterest.expertise_level + 0.05);
      }
    } else if (profile.interests.length < this.maxInterestCount) {
      // Create new interest
      const newInterest: Interest = {
        id: uuid(),
        topic,
        category: this.categorizeInterest(topic, analysis),
        intensity: Math.min(0.7, analysis.emotion.emotionIntensity + 0.3),
        expertise_level: analysis.topic.expertise_required || 0.2,
        firstMentioned: timestamp,
        lastMentioned: timestamp,
        mentionCount: 1,
        relatedInterests: [],
        keywords: analysis.topic.keywords.map(k => k.term),
        sentiment: this.determineInterestSentiment(analysis),
        growthPotential: analysis.learning?.learningOpportunity.value || 0.5,
        learningGoals: []
      };

      profile.interests.push(newInterest);
      
      this.emit('interest_discovered', {
        userId: profile.userId,
        interest: newInterest
      });
    }
  }

  @bindThis
  private categorizeInterest(topic: string, analysis: ConversationAnalysis): InterestCategory {
    // Simple categorization based on topic content and analysis
    const topicLower = topic.toLowerCase();
    
    if (analysis.topic.topicCategory === 'technical' || 
        topicLower.includes('programming') || topicLower.includes('code')) {
      return 'technology';
    } else if (topicLower.includes('art') || topicLower.includes('design')) {
      return 'arts';
    } else if (topicLower.includes('music') || topicLower.includes('song')) {
      return 'music';
    } else if (topicLower.includes('book') || topicLower.includes('read')) {
      return 'literature';
    } else if (topicLower.includes('business') || topicLower.includes('work')) {
      return 'business';
    } else if (topicLower.includes('health') || topicLower.includes('fitness')) {
      return 'health';
    } else {
      return 'other';
    }
  }

  @bindThis
  private determineInterestSentiment(analysis: ConversationAnalysis): any {
    if (analysis.emotion.sentiment.polarity > 0.5) {
      return 'passionate';
    } else if (analysis.emotion.sentiment.polarity > 0.2) {
      return 'positive';
    } else if (analysis.emotion.sentiment.polarity < -0.2) {
      return 'negative';
    } else {
      return 'neutral';
    }
  }

  @bindThis
  private pruneStaleInterests(profile: DynamicUserProfile): void {
    const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days ago
    
    profile.interests = profile.interests.filter(interest => {
      const isRecent = interest.lastMentioned > cutoffDate;
      const isImportant = interest.intensity > 0.6 || interest.mentionCount > 5;
      
      return isRecent || isImportant;
    });
  }

  @bindThis
  private async updateExpertise(
    profile: DynamicUserProfile,
    context: ProfileUpdateContext
  ): Promise<void> {
    const { analysis } = context;
    
    // Only create expertise areas for topics with high complexity/expertise requirements
    if (analysis.topic.expertise_required > 0.6) {
      const domain = analysis.topic.mainTopic;
      const existingExpertise = profile.expertise.find(e => 
        e.domain.toLowerCase() === domain.toLowerCase()
      );

      if (existingExpertise) {
        // Update existing expertise
        existingExpertise.recentActivity = context.timestamp;
        if (analysis.topic.complexity > 0.8) {
          existingExpertise.level = this.advanceExpertiseLevel(existingExpertise.level);
          existingExpertise.confidence = Math.min(1, existingExpertise.confidence + 0.05);
        }
      } else if (profile.expertise.length < this.maxExpertiseCount) {
        // Create new expertise area
        const newExpertise: ExpertiseArea = {
          id: uuid(),
          domain,
          subdomains: analysis.topic.subTopics,
          level: this.determineInitialExpertiseLevel(analysis),
          confidence: analysis.topic.expertise_required,
          evidenceQuality: 0.7,
          verificationSources: ['conversation_analysis'],
          demonstratedSkills: analysis.topic.keywords.slice(0, 5).map(k => k.term),
          knowledgeGaps: [],
          recentActivity: context.timestamp,
          progressRate: 0.3,
          teachingAbility: 0.4
        };

        profile.expertise.push(newExpertise);
        
        this.emit('expertise_identified', {
          userId: profile.userId,
          expertise: newExpertise
        });
      }
    }
  }

  @bindThis
  private determineInitialExpertiseLevel(analysis: ConversationAnalysis): ExpertiseLevel {
    const complexity = analysis.topic.complexity;
    const expertiseRequired = analysis.topic.expertise_required;
    
    const score = (complexity + expertiseRequired) / 2;
    
    if (score > 0.8) return 'advanced';
    if (score > 0.6) return 'intermediate';
    if (score > 0.4) return 'beginner';
    return 'novice';
  }

  @bindThis
  private advanceExpertiseLevel(currentLevel: ExpertiseLevel): ExpertiseLevel {
    const progression: ExpertiseLevel[] = ['novice', 'beginner', 'intermediate', 'advanced', 'expert', 'master'];
    const currentIndex = progression.indexOf(currentLevel);
    return progression[Math.min(currentIndex + 1, progression.length - 1)];
  }

  // =====================================================================
  // Behavior Pattern Analysis
  // =====================================================================

  @bindThis
  private async updateBehaviorPatterns(
    profile: DynamicUserProfile,
    context: ProfileUpdateContext
  ): Promise<void> {
    const { analysis, timestamp } = context;
    
    // Update active hours
    const hour = timestamp.getHours();
    if (!profile.behaviorPatterns.activeHours.includes(hour)) {
      profile.behaviorPatterns.activeHours.push(hour);
      profile.behaviorPatterns.activeHours.sort((a, b) => a - b);
    }

    // Update question type patterns
    this.updateQuestionTypePatterns(profile, context);
    
    // Update emotional patterns
    this.updateEmotionalPatterns(profile, analysis);
    
    // Update learning behavior
    this.updateLearningBehavior(profile, analysis);
    
    // Update decision making style
    this.updateDecisionMakingStyle(profile, analysis);
  }

  @bindThis
  private updateQuestionTypePatterns(
    profile: DynamicUserProfile,
    context: ProfileUpdateContext
  ): void {
    const { messageContent, analysis } = context;
    const questionCount = (messageContent.match(/\?/g) || []).length;
    
    if (questionCount > 0) {
      // Analyze question types based on intent and content
      const questionType = this.classifyQuestionType(messageContent, analysis);
      
      const existingPattern = profile.behaviorPatterns.questionTypes.find(
        qt => qt.type === questionType
      );
      
      if (existingPattern) {
        existingPattern.frequency = Math.min(1, existingPattern.frequency + 0.05);
      } else {
        profile.behaviorPatterns.questionTypes.push({
          type: questionType,
          frequency: 0.2,
          complexity: analysis.topic.complexity
        });
      }
    }
  }

  @bindThis
  private classifyQuestionType(messageContent: string, analysis: ConversationAnalysis): QuestionType {
    const content = messageContent.toLowerCase();
    
    if (content.includes('what') || content.includes('when') || content.includes('where')) {
      return 'factual';
    } else if (content.includes('how') || content.includes('why')) {
      return 'analytical';
    } else if (content.includes('what if') || content.includes('imagine')) {
      return 'hypothetical';
    } else if (analysis.intent.primaryIntent === 'creative_collaboration') {
      return 'creative';
    } else if (analysis.topic.topicCategory === 'personal') {
      return 'personal';
    } else if (content.includes('think') || content.includes('opinion')) {
      return 'opinion';
    } else {
      return 'clarification';
    }
  }

  @bindThis
  private updateEmotionalPatterns(
    profile: DynamicUserProfile,
    analysis: ConversationAnalysis
  ): void {
    // Create or update emotional pattern
    const pattern = profile.behaviorPatterns.emotionalPatterns[0] || {
      dominantEmotion: 'neutral' as EmotionType,
      emotionalRange: 0.5,
      emotionalStability: 0.7,
      empathyLevel: 0.5,
      emotionalExpression: 0.5
    };

    // Update dominant emotion based on frequency
    if (analysis.emotion.emotionIntensity > 0.6) {
      pattern.dominantEmotion = analysis.emotion.primaryEmotion;
    }

    // Update emotional stability
    if (analysis.emotion.emotionalStability < pattern.emotionalStability) {
      pattern.emotionalStability = Math.max(0, pattern.emotionalStability - 0.05);
    } else {
      pattern.emotionalStability = Math.min(1, pattern.emotionalStability + 0.02);
    }

    // Update emotional expression
    pattern.emotionalExpression = Math.min(1, 
      pattern.emotionalExpression + analysis.emotion.emotionIntensity * 0.1
    );

    if (profile.behaviorPatterns.emotionalPatterns.length === 0) {
      profile.behaviorPatterns.emotionalPatterns.push(pattern);
    }
  }

  @bindThis
  private updateLearningBehavior(
    profile: DynamicUserProfile,
    analysis: ConversationAnalysis
  ): void {
    const learning = profile.behaviorPatterns.learningBehavior;
    
    // Update learning style preferences based on engagement patterns
    if (analysis.learning?.learningOpportunity.value > 0.7) {
      const engagementType = analysis.learning.learningOpportunity.type;
      
      if (engagementType === 'creative_exploration' && 
          !learning.preferredLearningStyle.includes('practice')) {
        learning.preferredLearningStyle.push('practice');
      }
    }

    // Update feedback sensitivity
    if (analysis.personalization.feedbackIntegration.explicit.length > 0) {
      learning.feedbackSensitivity = Math.min(1, learning.feedbackSensitivity + 0.05);
    }

    // Update experimentation tendency
    if (analysis.topic.novelty > 0.7) {
      learning.experimentationTendency = Math.min(1, learning.experimentationTendency + 0.05);
    }
  }

  @bindThis
  private updateDecisionMakingStyle(
    profile: DynamicUserProfile,
    analysis: ConversationAnalysis
  ): void {
    const style = profile.behaviorPatterns.decisionMakingStyle;
    
    // Update analytical vs intuitive based on reasoning patterns
    if (analysis.topic.complexity > 0.7 && analysis.intent.complexity > 0.6) {
      style.analyticalVsIntuitive = Math.min(1, style.analyticalVsIntuitive + 0.05);
    }

    // Update risk tolerance based on goal setting and challenge engagement
    if (analysis.learning?.learningOpportunity.value > 0.8) {
      style.riskTolerance = Math.min(1, style.riskTolerance + 0.03);
    }

    // Update information need based on question patterns
    const questionCount = profile.behaviorPatterns.questionTypes.length;
    if (questionCount > 5) {
      style.informationNeed = Math.min(1, style.informationNeed + 0.02);
    }
  }

  // =====================================================================
  // Learning Journey Updates
  // =====================================================================

  @bindThis
  private async updateLearningJourney(
    profile: DynamicUserProfile,
    context: ProfileUpdateContext
  ): Promise<void> {
    const { analysis } = context;
    const journey = profile.learningJourney;
    
    // Update overall progress based on learning engagement
    if (analysis.learning?.learningOpportunity.value > 0.6) {
      journey.overallProgress = Math.min(1, journey.overallProgress + 0.01);
      journey.learningVelocity = Math.min(1, journey.learningVelocity + 0.02);
    }

    // Track learning milestones for significant learning events
    if (analysis.learning?.learningOpportunity.value > 0.8) {
      const milestone = {
        id: uuid(),
        timestamp: context.timestamp,
        type: 'knowledge_expansion' as any,
        description: `Engaged with ${analysis.topic.mainTopic} learning opportunity`,
        significance: analysis.learning.learningOpportunity.value,
        skillsGained: [],
        knowledgeAreas: [analysis.topic.mainTopic],
        capabilitiesUnlocked: [],
        futureOpportunities: [],
        nextLearningSteps: []
      };

      journey.learningMilestones.push(milestone);
      
      // Keep only recent milestones
      if (journey.learningMilestones.length > 20) {
        journey.learningMilestones = journey.learningMilestones
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          .slice(0, 20);
      }
    }
  }

  // =====================================================================
  // Profile Metrics and Quality Assessment
  // =====================================================================

  @bindThis
  private calculateProfileMetrics(profile: DynamicUserProfile): void {
    // Calculate data confidence based on interaction count and evidence quality
    const interactionFactor = Math.min(1, profile.metadata.interactionCount / 50);
    const personalityConfidence = Object.values(profile.personality.confidence)
      .reduce((sum, conf) => sum + conf, 0) / Object.keys(profile.personality.confidence).length;
    
    profile.metadata.dataConfidence = (interactionFactor + personalityConfidence) / 2;

    // Calculate completeness based on filled profile sections
    let completenessScore = 0;
    let totalSections = 10;

    // Basic info completeness
    if (profile.displayName || profile.preferredName) completenessScore += 1;
    
    // Personality completeness
    if (personalityConfidence > 0.3) completenessScore += 1;
    
    // Communication preferences
    completenessScore += 1; // Always some data from interactions
    
    // Relationship development
    if (profile.relationshipLevel.stage !== 'stranger') completenessScore += 1;
    
    // Interests
    if (profile.interests.length > 0) completenessScore += 1;
    
    // Expertise
    if (profile.expertise.length > 0) completenessScore += 1;
    
    // Goals
    if (profile.goals.length > 0) completenessScore += 1;
    
    // Behavior patterns
    if (profile.behaviorPatterns.activeHours.length > 0) completenessScore += 1;
    
    // Learning journey
    if (profile.learningJourney.learningMilestones.length > 0) completenessScore += 1;
    
    // Privacy and consent
    completenessScore += 1; // Always configured
    
    profile.metadata.completeness = completenessScore / totalSections;

    // Calculate quality score
    profile.metadata.qualityScore = (
      profile.metadata.dataConfidence * 0.4 +
      profile.metadata.completeness * 0.3 +
      (profile.metadata.interactionCount / 100) * 0.3
    );
  }

  // =====================================================================
  // Storage Operations
  // =====================================================================

  @bindThis
  private async loadProfileFromStorage(userId: string): Promise<DynamicUserProfile | null> {
    // This would typically load from the persistent database
    // For now, return null to indicate no saved profile
    return null;
  }

  @bindThis
  private async saveProfileToStorage(profile: DynamicUserProfile): Promise<void> {
    // This would typically save to the persistent database
    // For now, just update the in-memory profile
    this.profiles.set(profile.userId, profile);
  }

  // =====================================================================
  // Public API Methods
  // =====================================================================

  @bindThis
  async getProfile(userId: string): Promise<DynamicUserProfile | null> {
    return this.profiles.get(userId) || null;
  }

  @bindThis
  async getAllProfiles(): Promise<DynamicUserProfile[]> {
    return Array.from(this.profiles.values());
  }

  @bindThis
  async deleteProfile(userId: string): Promise<boolean> {
    const deleted = this.profiles.delete(userId);
    if (deleted) {
      this.emit('profile_deleted', { userId });
    }
    return deleted;
  }

  @bindThis
  async getProfileStats(): Promise<any> {
    const profiles = Array.from(this.profiles.values());
    
    return {
      totalProfiles: profiles.length,
      averageCompleteness: profiles.reduce((sum, p) => sum + p.metadata.completeness, 0) / profiles.length,
      averageDataConfidence: profiles.reduce((sum, p) => sum + p.metadata.dataConfidence, 0) / profiles.length,
      relationshipStages: profiles.reduce((stages, p) => {
        stages[p.relationshipLevel.stage] = (stages[p.relationshipLevel.stage] || 0) + 1;
        return stages;
      }, {} as Record<string, number>)
    };
  }
}

export default DynamicProfileManager;