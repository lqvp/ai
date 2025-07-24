/**
 * Profile Manager - Handles user profile creation, updates, and learning
 */

import { Pool } from 'pg';
import {
  UserProfile,
  RelationshipLevel,
  PersonalizationError,
  InferredDataPoint,
  TopicInterest,
  SentimentDataPoint,
  BigFiveTraits,
  CommunicationStyle,
  AnalyticsEvent
} from '../types/index.js';

export class ProfileManager {
  private db: Pool;
  private inferenceEngine: InferenceEngine;
  
  constructor(
    databaseUrl: string,
    inferenceEngine: InferenceEngine
  ) {
    this.db = new Pool({ connectionString: databaseUrl });
    this.inferenceEngine = inferenceEngine;
  }

  /**
   * Initialize database tables
   */
  async initialize(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id VARCHAR(255) PRIMARY KEY,
        profile_data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_user_profiles_updated 
      ON user_profiles(updated_at);
    `);
  }

  /**
   * Get or create user profile
   */
  async getOrCreateProfile(userId: string): Promise<UserProfile> {
    const result = await this.db.query(
      'SELECT profile_data FROM user_profiles WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length > 0) {
      return this.deserializeProfile(result.rows[0].profile_data);
    }

    // Create new profile
    const newProfile = this.createDefaultProfile(userId);
    await this.saveProfile(newProfile);
    return newProfile;
  }

  /**
   * Update user profile
   */
  async updateProfile(
    userId: string,
    updates: Partial<UserProfile>
  ): Promise<UserProfile> {
    const currentProfile = await this.getOrCreateProfile(userId);
    
    // Merge updates
    const updatedProfile: UserProfile = {
      ...currentProfile,
      ...updates,
      metadata: {
        ...currentProfile.metadata,
        ...updates.metadata,
        updatedAt: new Date()
      }
    };

    await this.saveProfile(updatedProfile);
    return updatedProfile;
  }

  /**
   * Learn from conversation
   */
  async learnFromConversation(
    userId: string,
    events: AnalyticsEvent[]
  ): Promise<ProfileUpdateResult> {
    const profile = await this.getOrCreateProfile(userId);
    const updates: ProfileUpdate[] = [];

    // Analyze events for profile insights
    const insights = await this.inferenceEngine.analyzeEvents(events, profile);

    // Update confirmed information
    if (insights.confirmedInfo) {
      for (const [key, value] of Object.entries(insights.confirmedInfo)) {
        profile.identity.confirmedInfo[key] = value;
        updates.push({
          type: 'confirmed_info',
          field: key,
          value,
          confidence: 1.0
        });
      }
    }

    // Update inferred information
    if (insights.inferredInfo) {
      for (const [key, inference] of Object.entries(insights.inferredInfo)) {
        const existing = profile.identity.inferredInfo[key];
        
        // Only update if confidence is higher or doesn't exist
        if (!existing || inference.confidence > existing.confidence) {
          profile.identity.inferredInfo[key] = {
            value: inference.value,
            confidence: inference.confidence,
            source: inference.source,
            timestamp: new Date(),
            confirmationStatus: 'unconfirmed'
          };
          
          updates.push({
            type: 'inferred_info',
            field: key,
            value: inference.value,
            confidence: inference.confidence
          });
        }
      }
    }

    // Update preferences based on behavior
    if (insights.preferences) {
      profile.preferences = this.mergePreferences(
        profile.preferences,
        insights.preferences
      );
      
      updates.push({
        type: 'preferences',
        field: 'communication',
        value: profile.preferences.communication,
        confidence: 0.8
      });
    }

    // Update personality traits
    if (insights.personalityTraits) {
      profile.personality.traits = this.updatePersonalityTraits(
        profile.personality.traits,
        insights.personalityTraits
      );
      
      updates.push({
        type: 'personality',
        field: 'traits',
        value: profile.personality.traits,
        confidence: 0.7
      });
    }

    // Update topic interests
    if (insights.topicInterests) {
      for (const topic of insights.topicInterests) {
        this.updateTopicInterest(profile, topic);
      }
    }

    // Update sentiment history
    if (insights.sentiment) {
      profile.statistics.sentimentTrend.push({
        date: new Date(),
        sentiment: insights.sentiment,
        confidence: insights.sentimentConfidence || 0.8
      });
      
      // Keep only last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      profile.statistics.sentimentTrend = profile.statistics.sentimentTrend.filter(
        s => s.date > thirtyDaysAgo
      );
    }

    // Update relationship level
    const newRelationshipLevel = this.calculateRelationshipLevel(profile);
    if (newRelationshipLevel !== profile.metadata.relationshipLevel) {
      profile.metadata.relationshipLevel = newRelationshipLevel;
      updates.push({
        type: 'relationship',
        field: 'level',
        value: newRelationshipLevel,
        confidence: 1.0
      });
    }

    // Update trust score
    profile.metadata.trustScore = this.calculateTrustScore(profile);

    // Update statistics
    profile.statistics.totalInteractions += events.length;
    profile.metadata.lastActiveAt = new Date();

    // Save updated profile
    await this.saveProfile(profile);

    return {
      profileId: userId,
      updates,
      newRelationshipLevel: profile.metadata.relationshipLevel,
      trustScore: profile.metadata.trustScore
    };
  }

  /**
   * Get profile summary for user
   */
  async getProfileSummary(userId: string): Promise<string> {
    const profile = await this.getOrCreateProfile(userId);
    
    const summary: string[] = [];
    
    // Basic info
    if (profile.identity.confirmedInfo.name) {
      summary.push(`あなたのお名前は${profile.identity.confirmedInfo.name}さんですね。`);
    }
    
    // Relationship level
    const relationshipDescriptions = {
      new: '初めてお話しする方',
      familiar: 'お話したことがある方',
      friend: '親しい友人',
      collaborator: '信頼できるパートナー'
    };
    summary.push(`私たちの関係は「${relationshipDescriptions[profile.metadata.relationshipLevel]}」です。`);
    
    // Interests
    const topInterests = profile.preferences.topics.interests
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    
    if (topInterests.length > 0) {
      const interestList = topInterests.map(i => i.topic).join('、');
      summary.push(`${interestList}に興味をお持ちのようですね。`);
    }
    
    // Communication style
    const formalityLevel = profile.preferences.communication.formality;
    if (formalityLevel > 0.7) {
      summary.push('丁寧な会話がお好みのようです。');
    } else if (formalityLevel < 0.3) {
      summary.push('カジュアルな会話がお好みのようです。');
    }
    
    // Personality insights
    const dominantTrait = this.getDominantPersonalityTrait(profile.personality.traits);
    const traitDescriptions = {
      openness: '新しいことに興味を持つ好奇心旺盛な方',
      conscientiousness: '計画的で几帳面な方',
      extraversion: '社交的で活発な方',
      agreeableness: '協調性があり思いやりのある方',
      emotionalStability: '冷静で安定した方'
    };
    
    if (dominantTrait) {
      summary.push(`${traitDescriptions[dominantTrait]}だと感じています。`);
    }
    
    // Statistics
    summary.push(`これまで${profile.statistics.totalInteractions}回の会話をさせていただきました。`);
    
    return summary.join('\n');
  }

  /**
   * Export user data
   */
  async exportUserData(userId: string): Promise<UserDataExport> {
    const profile = await this.getOrCreateProfile(userId);
    
    return {
      profile,
      exportedAt: new Date(),
      format: 'json',
      version: '1.0'
    };
  }

  /**
   * Delete user profile
   */
  async deleteProfile(userId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM user_profiles WHERE user_id = $1',
      [userId]
    );
  }

  /**
   * Helper methods
   */
  private createDefaultProfile(userId: string): UserProfile {
    const now = new Date();
    
    return {
      userId,
      metadata: {
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
        relationshipLevel: 'new',
        trustScore: 0.5,
        version: 1
      },
      identity: {
        confirmedInfo: {},
        inferredInfo: {}
      },
      preferences: {
        communication: {
          responseLength: 'adaptive',
          formality: 0.5,
          emotionalTone: 0.5,
          humor: 0.3,
          technicalDepth: 0.5,
          creativity: 0.5
        },
        topics: {
          interests: [],
          avoidTopics: [],
          expertise: []
        },
        interaction: {
          preferredTimes: [],
          responseSpeed: 'flexible',
          initiativeLevel: 0.5,
          privacyLevel: 'moderate'
        }
      },
      personality: {
        traits: {
          openness: 0.5,
          conscientiousness: 0.5,
          extraversion: 0.5,
          agreeableness: 0.5,
          emotionalStability: 0.5
        },
        communicationStyle: {
          assertiveness: 0.5,
          analyticalThinking: 0.5,
          creativity: 0.5,
          empathy: 0.5,
          directness: 0.5
        },
        cognitiveStyle: {
          detailOriented: 0.5,
          bigPictureThinking: 0.5,
          logicalReasoning: 0.5,
          intuitiveThinking: 0.5
        }
      },
      statistics: {
        totalInteractions: 0,
        averageResponseTime: 0,
        averageMessageLength: 0,
        sentimentTrend: [],
        topicDistribution: new Map(),
        engagementMetrics: {
          sessionCount: 0,
          averageSessionDuration: 0,
          messageFrequency: 0,
          responseRate: 1.0
        }
      }
    };
  }

  private async saveProfile(profile: UserProfile): Promise<void> {
    const serialized = this.serializeProfile(profile);
    
    await this.db.query(`
      INSERT INTO user_profiles (user_id, profile_data, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id)
      DO UPDATE SET 
        profile_data = $2,
        updated_at = CURRENT_TIMESTAMP
    `, [profile.userId, serialized]);
  }

  private serializeProfile(profile: UserProfile): any {
    return {
      ...profile,
      statistics: {
        ...profile.statistics,
        topicDistribution: Array.from(profile.statistics.topicDistribution.entries())
      }
    };
  }

  private deserializeProfile(data: any): UserProfile {
    return {
      ...data,
      metadata: {
        ...data.metadata,
        createdAt: new Date(data.metadata.createdAt),
        updatedAt: new Date(data.metadata.updatedAt),
        lastActiveAt: new Date(data.metadata.lastActiveAt)
      },
      statistics: {
        ...data.statistics,
        topicDistribution: new Map(data.statistics.topicDistribution),
        sentimentTrend: data.statistics.sentimentTrend.map((s: any) => ({
          ...s,
          date: new Date(s.date)
        }))
      }
    };
  }

  private mergePreferences(current: any, updates: any): any {
    // Weighted average merge strategy
    const weight = 0.3; // Weight for new data
    
    return {
      communication: {
        responseLength: updates.communication?.responseLength || current.communication.responseLength,
        formality: this.weightedAverage(
          current.communication.formality,
          updates.communication?.formality,
          weight
        ),
        emotionalTone: this.weightedAverage(
          current.communication.emotionalTone,
          updates.communication?.emotionalTone,
          weight
        ),
        humor: this.weightedAverage(
          current.communication.humor,
          updates.communication?.humor,
          weight
        ),
        technicalDepth: this.weightedAverage(
          current.communication.technicalDepth,
          updates.communication?.technicalDepth,
          weight
        ),
        creativity: this.weightedAverage(
          current.communication.creativity,
          updates.communication?.creativity,
          weight
        )
      },
      topics: current.topics,
      interaction: current.interaction
    };
  }

  private updatePersonalityTraits(
    current: BigFiveTraits,
    updates: Partial<BigFiveTraits>
  ): BigFiveTraits {
    const weight = 0.2; // Personality changes slowly
    
    return {
      openness: this.weightedAverage(current.openness, updates.openness, weight),
      conscientiousness: this.weightedAverage(
        current.conscientiousness,
        updates.conscientiousness,
        weight
      ),
      extraversion: this.weightedAverage(current.extraversion, updates.extraversion, weight),
      agreeableness: this.weightedAverage(current.agreeableness, updates.agreeableness, weight),
      emotionalStability: this.weightedAverage(
        current.emotionalStability,
        updates.emotionalStability,
        weight
      )
    };
  }

  private updateTopicInterest(profile: UserProfile, topic: TopicUpdate): void {
    const existing = profile.preferences.topics.interests.find(
      i => i.topic === topic.topic
    );
    
    if (existing) {
      existing.score = this.weightedAverage(existing.score, topic.score, 0.3);
      existing.lastMentioned = new Date();
      existing.mentionCount++;
      existing.sentiment = this.weightedAverage(
        existing.sentiment,
        topic.sentiment || 0,
        0.3
      );
    } else {
      profile.preferences.topics.interests.push({
        topic: topic.topic,
        score: topic.score,
        lastMentioned: new Date(),
        mentionCount: 1,
        sentiment: topic.sentiment || 0
      });
    }
    
    // Keep top 50 interests
    profile.preferences.topics.interests.sort((a, b) => b.score - a.score);
    profile.preferences.topics.interests = profile.preferences.topics.interests.slice(0, 50);
  }

  private calculateRelationshipLevel(profile: UserProfile): RelationshipLevel {
    const interactions = profile.statistics.totalInteractions;
    const trustScore = profile.metadata.trustScore;
    
    if (interactions < 5) return 'new';
    if (interactions < 20 || trustScore < 0.6) return 'familiar';
    if (interactions < 50 || trustScore < 0.8) return 'friend';
    return 'collaborator';
  }

  private calculateTrustScore(profile: UserProfile): number {
    let score = 0.5; // Base score
    
    // Factor in interactions
    const interactions = profile.statistics.totalInteractions;
    score += Math.min(0.2, interactions * 0.002); // Max 0.2 from interactions
    
    // Factor in positive sentiment
    const recentSentiments = profile.statistics.sentimentTrend.slice(-10);
    if (recentSentiments.length > 0) {
      const avgSentiment = recentSentiments.reduce(
        (sum, s) => sum + s.sentiment,
        0
      ) / recentSentiments.length;
      score += avgSentiment * 0.1; // Max ±0.1 from sentiment
    }
    
    // Factor in confirmed information
    const confirmedFields = Object.keys(profile.identity.confirmedInfo).length;
    score += Math.min(0.1, confirmedFields * 0.02); // Max 0.1 from confirmed info
    
    // Factor in engagement
    if (profile.statistics.engagementMetrics.responseRate > 0.8) {
      score += 0.1;
    }
    
    return Math.max(0, Math.min(1, score));
  }

  private getDominantPersonalityTrait(traits: BigFiveTraits): keyof BigFiveTraits | null {
    const entries = Object.entries(traits) as Array<[keyof BigFiveTraits, number]>;
    const sorted = entries.sort((a, b) => b[1] - a[1]);
    
    // Only return if significantly higher than average
    if (sorted[0][1] > 0.7) {
      return sorted[0][0];
    }
    
    return null;
  }

  private weightedAverage(
    current: number | undefined,
    update: number | undefined,
    weight: number
  ): number {
    if (current === undefined) return update || 0.5;
    if (update === undefined) return current;
    return current * (1 - weight) + update * weight;
  }

  /**
   * Cleanup
   */
  async disconnect(): Promise<void> {
    await this.db.end();
  }
}

/**
 * Interfaces
 */
export interface InferenceEngine {
  analyzeEvents(
    events: AnalyticsEvent[],
    profile: UserProfile
  ): Promise<ProfileInsights>;
}

export interface ProfileInsights {
  confirmedInfo?: Record<string, any>;
  inferredInfo?: Record<string, InferenceResult>;
  preferences?: any;
  personalityTraits?: Partial<BigFiveTraits>;
  topicInterests?: TopicUpdate[];
  sentiment?: number;
  sentimentConfidence?: number;
}

export interface InferenceResult {
  value: any;
  confidence: number;
  source: string;
}

export interface TopicUpdate {
  topic: string;
  score: number;
  sentiment?: number;
}

export interface ProfileUpdate {
  type: 'confirmed_info' | 'inferred_info' | 'preferences' | 'personality' | 'relationship';
  field: string;
  value: any;
  confidence: number;
}

export interface ProfileUpdateResult {
  profileId: string;
  updates: ProfileUpdate[];
  newRelationshipLevel: RelationshipLevel;
  trustScore: number;
}

export interface UserDataExport {
  profile: UserProfile;
  exportedAt: Date;
  format: string;
  version: string;
}