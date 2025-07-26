import { bindThis } from '@/decorators.js';
import loki from 'lokijs';
import {
  UserProfile,
  RelationshipLevel,
  CommunicationStyle,
  PersonalityTraits,
  BehaviorPattern,
  DataQuality,
  PersonalizationError,
  PersonalizationErrorCode
} from './types.js';

/**
 * ユーザープロファイルマネージャー
 * 明示的および暗黙的な情報を含む動的なユーザープロファイルを管理
 */
export default class UserProfileManager {
  private profiles: loki.Collection<UserProfile>;
  private readonly PROFILE_VERSION = 1;
  
  // 関係性レベルの閾値
  private readonly RELATIONSHIP_THRESHOLDS = {
    ACQUAINTANCE: 5,
    FAMILIAR: 20,
    FRIEND: 50,
    COLLABORATOR: 100
  };
  
  // 情報タイプ別の減衰率
  private readonly DECAY_RATES = {
    interests: 0.95, // 遅い減衰
    patterns: 0.90, // 中程度の減衰
    mood: 0.70 // 速い減衰
  };

  constructor(private db: loki) {
    this.profiles = this.db.getCollection('userProfiles') || 
      this.db.addCollection('userProfiles', {
        indices: ['userId'],
        unique: ['userId']
      });
  }

  /**
   * ユーザープロファイルを取得または作成
   */
  @bindThis
  public async getOrCreateProfile(userId: string): Promise<UserProfile> {
    let profile = this.profiles.findOne({ userId });
    
    if (!profile) {
      profile = this.createDefaultProfile(userId);
      this.profiles.insert(profile);
    }
    
    return profile;
  }

  /**
   * 新しい情報でユーザープロファイルを更新
   */
  @bindThis
  public async updateProfile(
    userId: string,
    updates: Partial<UserProfile>
  ): Promise<UserProfile> {
    const profile = await this.getOrCreateProfile(userId);
    
    // Deep merge updates
    this.mergeProfileUpdates(profile, updates);
    
    // Update metadata
    profile.updatedAt = Date.now();
    profile.meta.version = this.PROFILE_VERSION;
    
    // Update relationship level based on interactions
    this.updateRelationshipLevel(profile);
    
    // Update data quality assessment
    this.assessDataQuality(profile);
    
    this.profiles.update(profile);
    return profile;
  }

  /**
   * ユーザーが提供した明示的な情報を追加
   */
  @bindThis
  public async addExplicitInfo(
    userId: string,
    info: Partial<UserProfile['explicit']>
  ): Promise<UserProfile> {
    const profile = await this.getOrCreateProfile(userId);
    
    // Merge explicit information
    Object.assign(profile.explicit, info);
    
    // Update arrays without duplicates
    if (info.interests) {
      profile.explicit.interests = [...new Set([
        ...profile.explicit.interests,
        ...info.interests
      ])];
    }
    
    if (info.goals) {
      profile.explicit.goals = [...new Set([
        ...profile.explicit.goals,
        ...info.goals
      ])];
    }
    
    profile.updatedAt = Date.now();
    this.profiles.update(profile);
    
    return profile;
  }

  /**
   * ユーザーの対話から暗黙的な情報を推論
   */
  @bindThis
  public async inferImplicitInfo(
    userId: string,
    interaction: {
      message: string;
      context?: string;
      sentiment?: number;
      entities?: string[];
    }
  ): Promise<UserProfile> {
    const profile = await this.getOrCreateProfile(userId);
    
    // Infer communication style
    const style = this.inferCommunicationStyle(interaction.message);
    if (style && (!profile.implicit.communicationStyle || 
        this.shouldUpdateInference(profile.meta.lastAnalyzed))) {
      profile.implicit.communicationStyle = style;
    }
    
    // Extract and update expertise
    const expertise = this.extractExpertise(interaction.message, interaction.entities);
    if (expertise.length > 0) {
      profile.implicit.expertise = this.mergeWithConfidence(
        profile.implicit.expertise,
        expertise
      );
    }
    
    // Update personality traits based on interaction
    this.updatePersonalityTraits(profile, interaction);
    
    // Track behavior patterns
    this.trackBehaviorPattern(profile, interaction);
    
    profile.meta.lastAnalyzed = Date.now();
    this.profiles.update(profile);
    
    return profile;
  }

  /**
   * 対話統計を更新
   */
  @bindThis
  public async recordInteraction(
    userId: string,
    quality: number = 1.0
  ): Promise<UserProfile> {
    try {
      const profile = await this.getOrCreateProfile(userId);
      
      profile.relationship.totalInteractions++;
      profile.relationship.lastInteraction = Date.now();
      
      // Update trust score based on interaction quality
      profile.relationship.trustScore = this.updateTrustScore(
        profile.relationship.trustScore,
        quality,
        profile.relationship.totalInteractions
      );
      
      // Check for relationship level upgrade
      this.updateRelationshipLevel(profile);
      
      this.profiles.update(profile);
      return profile;
    } catch (error) {
      console.error('Error recording interaction:', error);
      throw new PersonalizationError(
        'Failed to record interaction',
        PersonalizationErrorCode.PROFILE_UPDATE_FAILED
      );
    }
  }

  /**
   * 応答生成のための関係性コンテキストを取得
   */
  @bindThis
  public getRelationshipContext(profile: UserProfile): string {
    const level = profile.relationship.level;
    const interactions = profile.relationship.totalInteractions;
    
    switch (level) {
      case RelationshipLevel.NEW_USER:
        return "新しいユーザーです。歓迎し、親切に対応し、物事を明確に説明してください。";
      
      case RelationshipLevel.ACQUAINTANCE:
        return `${interactions}回の対話がありました。友好的でありながら、まだ説明的に対応してください。`;
      
      case RelationshipLevel.FAMILIAR:
        return `${interactions}回の対話がある親しいユーザーです。よりカジュアルに、過去の会話を参照できます。`;
      
      case RelationshipLevel.FRIEND:
        return `${interactions}回の対話がある友人です。温かく、個人的に、共有した経験を参照してください。`;
      
      case RelationshipLevel.COLLABORATOR:
        return `${interactions}回の対話がある親密な協力者です。高度にパーソナライズし、ニーズを予測し、深い共有コンテキストを構築してください。`;
      
      default:
        return "自然で親切に対話してください。";
    }
  }

  /**
   * コミュニケーションスタイルのガイダンスを取得
   */
  @bindThis
  public getStyleGuidance(profile: UserProfile): string {
    const style = profile.implicit.communicationStyle;
    
    if (!style) {
      return "ユーザーの好みに基づいてコミュニケーションスタイルを適応させてください。";
    }
    
    switch (style) {
      case CommunicationStyle.FORMAL:
        return "フォーマルな言葉遣い、完全な文章、プロフェッショナルなトーンを使用してください。";
      
      case CommunicationStyle.CASUAL:
        return "カジュアルで友好的な言葉遣い、省略形や口語表現を使用してください。";
      
      case CommunicationStyle.TECHNICAL:
        return "正確な技術用語を使用し、詳細と仕様を含めてください。";
      
      case CommunicationStyle.CREATIVE:
        return "創造的で表現豊かな言葉遣い、比喩や鮮明な描写を使用してください。";
      
      case CommunicationStyle.ANALYTICAL:
        return "論理的で構造化されたコミュニケーション、明確な理由付けと証拠を使用してください。";
      
      default:
        return "明確で自然なコミュニケーションを使用してください。";
    }
  }

  /**
   * Apply forgetting mechanism to profile data
   */
  @bindThis
  public async applyForgetting(userId: string): Promise<UserProfile> {
    const profile = await this.getOrCreateProfile(userId);
    const now = Date.now();
    const daysSinceLastInteraction = (now - profile.relationship.lastInteraction) / (1000 * 60 * 60 * 24);
    
    // Don't forget anything for active users
    if (daysSinceLastInteraction < 7) {
      return profile;
    }
    
    // Apply decay to behavior patterns
    profile.implicit.patterns = profile.implicit.patterns
      .map(pattern => ({
        ...pattern,
        confidence: pattern.confidence * Math.pow(this.DECAY_RATES.patterns, daysSinceLastInteraction / 30)
      }))
      .filter(pattern => pattern.confidence > 0.1); // Remove low confidence patterns
    
    // Decay personality trait confidence
    const decayFactor = Math.pow(0.98, daysSinceLastInteraction / 30);
    Object.keys(profile.implicit.personality).forEach(trait => {
      profile.implicit.personality[trait as keyof PersonalityTraits] *= decayFactor;
    });
    
    this.profiles.update(profile);
    return profile;
  }

  /**
   * Delete user profile
   */
  @bindThis
  public async deleteProfile(userId: string): Promise<void> {
    const profile = this.profiles.findOne({ userId });
    if (profile) {
      this.profiles.remove(profile);
    }
  }

  /**
   * Export user profile data
   */
  @bindThis
  public async exportProfile(userId: string): Promise<UserProfile | null> {
    return this.profiles.findOne({ userId });
  }

  // Private helper methods

  private createDefaultProfile(userId: string): UserProfile {
    const now = Date.now();
    return {
      userId,
      createdAt: now,
      updatedAt: now,
      explicit: {
        interests: [],
        goals: [],
        preferences: {}
      },
      implicit: {
        expertise: [],
        values: [],
        personality: {
          openness: 0.5,
          conscientiousness: 0.5,
          extraversion: 0.5,
          agreeableness: 0.5,
          neuroticism: 0.5
        },
        patterns: []
      },
      relationship: {
        level: RelationshipLevel.NEW_USER,
        firstInteraction: now,
        totalInteractions: 0,
        lastInteraction: now,
        trustScore: 0.5
      },
      meta: {
        version: this.PROFILE_VERSION,
        lastAnalyzed: now,
        dataQuality: DataQuality.LOW
      }
    };
  }

  private mergeProfileUpdates(
    profile: UserProfile,
    updates: Partial<UserProfile>
  ): void {
    // Deep merge implementation
    if (updates.explicit) {
      Object.assign(profile.explicit, updates.explicit);
    }
    if (updates.implicit) {
      Object.assign(profile.implicit, updates.implicit);
    }
    if (updates.relationship) {
      Object.assign(profile.relationship, updates.relationship);
    }
  }

  private updateRelationshipLevel(profile: UserProfile): void {
    const interactions = profile.relationship.totalInteractions;
    
    if (interactions >= this.RELATIONSHIP_THRESHOLDS.COLLABORATOR) {
      profile.relationship.level = RelationshipLevel.COLLABORATOR;
    } else if (interactions >= this.RELATIONSHIP_THRESHOLDS.FRIEND) {
      profile.relationship.level = RelationshipLevel.FRIEND;
    } else if (interactions >= this.RELATIONSHIP_THRESHOLDS.FAMILIAR) {
      profile.relationship.level = RelationshipLevel.FAMILIAR;
    } else if (interactions >= this.RELATIONSHIP_THRESHOLDS.ACQUAINTANCE) {
      profile.relationship.level = RelationshipLevel.ACQUAINTANCE;
    }
  }

  private assessDataQuality(profile: UserProfile): void {
    let qualityScore = 0;
    
    // Check explicit data completeness
    if (profile.explicit.name) qualityScore += 0.2;
    if (profile.explicit.interests.length > 0) qualityScore += 0.1;
    if (profile.explicit.goals.length > 0) qualityScore += 0.1;
    
    // Check implicit data richness
    if (profile.implicit.communicationStyle) qualityScore += 0.2;
    if (profile.implicit.expertise.length > 0) qualityScore += 0.2;
    if (profile.implicit.patterns.length > 0) qualityScore += 0.2;
    
    if (qualityScore >= 0.7) {
      profile.meta.dataQuality = DataQuality.HIGH;
    } else if (qualityScore >= 0.4) {
      profile.meta.dataQuality = DataQuality.MEDIUM;
    } else {
      profile.meta.dataQuality = DataQuality.LOW;
    }
  }

  private inferCommunicationStyle(message: string): CommunicationStyle | null {
    // Simple heuristics for communication style inference
    const formalIndicators = /\b(please|kindly|would you|could you|sincerely|regards)\b/i;
    const casualIndicators = /\b(hey|hi|yeah|gonna|wanna|lol|btw)\b/i;
    const technicalIndicators = /\b(API|database|algorithm|function|implementation|architecture)\b/i;
    const creativeIndicators = /\b(imagine|create|design|beautiful|inspire|dream)\b/i;
    const analyticalIndicators = /\b(analyze|compare|evaluate|consider|therefore|however)\b/i;
    
    if (formalIndicators.test(message)) return CommunicationStyle.FORMAL;
    if (casualIndicators.test(message)) return CommunicationStyle.CASUAL;
    if (technicalIndicators.test(message)) return CommunicationStyle.TECHNICAL;
    if (creativeIndicators.test(message)) return CommunicationStyle.CREATIVE;
    if (analyticalIndicators.test(message)) return CommunicationStyle.ANALYTICAL;
    
    return null;
  }

  private extractExpertise(message: string, entities?: string[]): string[] {
    const expertise: string[] = [];
    
    // Technical expertise patterns
    const techPatterns = {
      programming: /\b(code|programming|developer|software|debug)\b/i,
      data: /\b(data|analysis|statistics|machine learning|AI)\b/i,
      design: /\b(design|UX|UI|graphics|visual)\b/i,
      business: /\b(business|management|strategy|marketing|sales)\b/i
    };
    
    Object.entries(techPatterns).forEach(([field, pattern]) => {
      if (pattern.test(message)) {
        expertise.push(field);
      }
    });
    
    return expertise;
  }

  private updatePersonalityTraits(
    profile: UserProfile,
    interaction: { message: string; sentiment?: number }
  ): void {
    // Simple personality inference based on interaction patterns
    const messageLength = interaction.message.length;
    const questionCount = (interaction.message.match(/\?/g) || []).length;
    const exclamationCount = (interaction.message.match(/!/g) || []).length;
    
    // Update traits with small increments
    const delta = 0.02;
    
    // Openness: questions indicate curiosity
    if (questionCount > 0) {
      profile.implicit.personality.openness = Math.min(1, 
        profile.implicit.personality.openness + delta * questionCount
      );
    }
    
    // Extraversion: longer messages and exclamations
    if (messageLength > 100 || exclamationCount > 0) {
      profile.implicit.personality.extraversion = Math.min(1,
        profile.implicit.personality.extraversion + delta
      );
    }
    
    // Agreeableness: positive sentiment
    if (interaction.sentiment && interaction.sentiment > 0) {
      profile.implicit.personality.agreeableness = Math.min(1,
        profile.implicit.personality.agreeableness + delta * interaction.sentiment
      );
    }
  }

  private trackBehaviorPattern(
    profile: UserProfile,
    interaction: { message: string; context?: string }
  ): void {
    // Track common patterns
    const patterns: { [key: string]: boolean } = {
      'morning_greeting': /^(good morning|morning|gm)/i.test(interaction.message),
      'technical_questions': /\b(how|what|why|explain)\b.*\b(work|function|implement)\b/i.test(interaction.message),
      'creative_requests': /\b(create|make|design|build|write)\b/i.test(interaction.message),
      'learning_oriented': /\b(learn|understand|know|teach|explain)\b/i.test(interaction.message)
    };
    
    Object.entries(patterns).forEach(([type, detected]) => {
      if (detected) {
        const existing = profile.implicit.patterns.find(p => p.type === type);
        if (existing) {
          existing.frequency++;
          existing.lastOccurrence = Date.now();
          existing.confidence = Math.min(1, existing.confidence + 0.1);
        } else {
          profile.implicit.patterns.push({
            type,
            frequency: 1,
            lastOccurrence: Date.now(),
            confidence: 0.3
          });
        }
      }
    });
  }

  private updateTrustScore(
    currentScore: number,
    interactionQuality: number,
    totalInteractions: number
  ): number {
    // Weighted average with more weight on recent interactions
    const weight = Math.min(0.1, 1 / Math.sqrt(totalInteractions));
    return currentScore * (1 - weight) + interactionQuality * weight;
  }

  private shouldUpdateInference(lastAnalyzed: number): boolean {
    // Update inferences if more than 24 hours have passed
    return Date.now() - lastAnalyzed > 24 * 60 * 60 * 1000;
  }

  private mergeWithConfidence(existing: string[], newItems: string[]): string[] {
    // Simple merge for now - could be enhanced with confidence scores
    return [...new Set([...existing, ...newItems])];
  }
}