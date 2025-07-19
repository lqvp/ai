import { bindThis } from '@/decorators.js';
import type {
  UserProfile,
  ConversationAnalysis,
  ResponseGuidance,
} from './types.js';

interface PersonalizationContext {
  userProfile: UserProfile;
  currentAnalysis: ConversationAnalysis;
  timeOfDay: number;
  dayOfWeek: number;
  recentInteractions: number;
}

interface ResponseStyle {
  systemPromptAdditions: string[];
  temperatureAdjustment: number;
  maxTokensAdjustment: number;
  emojiGuidelines: string;
  toneGuidelines: string;
  lengthGuidelines: string;
}

export class AdaptivePersonalization {
  @bindThis
  generatePersonalizedStyle(context: PersonalizationContext): ResponseStyle {
    const { userProfile, currentAnalysis, timeOfDay } = context;
    
    const systemPromptAdditions: string[] = [];
    let temperatureAdjustment = 0;
    let maxTokensAdjustment = 0;

    // 性格特性に基づく調整
    const personality = userProfile.personality;
    
    // 開放性が高い場合は創造的な応答を促す
    if (personality.openness > 0.7) {
      systemPromptAdditions.push('創造的で新しいアイデアを含めた応答を心がけてください。');
      temperatureAdjustment += 0.1;
    } else if (personality.openness < 0.3) {
      systemPromptAdditions.push('実用的で具体的な応答を心がけてください。');
      temperatureAdjustment -= 0.1;
    }

    // 誠実性が高い場合は詳細で構造化された応答を促す
    if (personality.conscientiousness > 0.7) {
      systemPromptAdditions.push('詳細で整理された情報を提供してください。');
      maxTokensAdjustment += 200;
    } else if (personality.conscientiousness < 0.3) {
      systemPromptAdditions.push('要点を簡潔にまとめて応答してください。');
      maxTokensAdjustment -= 200;
    }

    // 外向性に基づくトーン調整
    if (personality.extraversion > 0.7) {
      systemPromptAdditions.push('活発で熱意のある口調で応答してください。');
    } else if (personality.extraversion < 0.3) {
      systemPromptAdditions.push('落ち着いた控えめな口調で応答してください。');
    }

    // 協調性に基づく共感度調整
    if (personality.agreeableness > 0.7) {
      systemPromptAdditions.push('共感的で思いやりのある応答を心がけてください。');
    }

    // 神経症傾向に基づく安心感の提供
    if (personality.neuroticism > 0.7) {
      systemPromptAdditions.push('安心感を与える穏やかな応答を心がけてください。');
    }

    // コミュニケーション好みに基づく調整
    const preferences = userProfile.preferences;
    
    // フォーマル度
    if (preferences.formality > 0.7) {
      systemPromptAdditions.push('丁寧で敬語を使った応答をしてください。');
    } else if (preferences.formality < 0.3) {
      systemPromptAdditions.push('カジュアルで親しみやすい口調で応答してください。');
    }

    // 感情表現
    if (preferences.emotionalExpression > 0.7) {
      systemPromptAdditions.push('感情豊かで表現力のある応答をしてください。');
    } else if (preferences.emotionalExpression < 0.3) {
      systemPromptAdditions.push('客観的で冷静な応答をしてください。');
    }

    // ユーモア
    if (preferences.humor > 0.7) {
      systemPromptAdditions.push('適度にユーモアを交えた応答をしてください。');
      temperatureAdjustment += 0.05;
    } else if (preferences.humor < 0.3) {
      systemPromptAdditions.push('真面目で事実に基づいた応答をしてください。');
    }

    // 技術的深さ
    if (preferences.technicalDepth > 0.7) {
      systemPromptAdditions.push('技術的な詳細を含めた専門的な応答をしてください。');
      maxTokensAdjustment += 300;
    } else if (preferences.technicalDepth < 0.3) {
      systemPromptAdditions.push('専門用語を避けた分かりやすい応答をしてください。');
    }

    // 時間帯による調整
    const timeBasedAdjustments = this.getTimeBasedAdjustments(timeOfDay);
    systemPromptAdditions.push(...timeBasedAdjustments);

    // 現在の感情状態に基づく調整
    const emotionAdjustments = this.getEmotionBasedAdjustments(currentAnalysis);
    systemPromptAdditions.push(...emotionAdjustments);

    // 絵文字使用のガイドライン
    const emojiGuidelines = this.getEmojiGuidelines(userProfile.communicationStyle.emojiUsage);

    // トーンのガイドライン
    const toneGuidelines = this.getToneGuidelines(currentAnalysis.guidance.tone, preferences);

    // 長さのガイドライン
    const lengthGuidelines = this.getLengthGuidelines(
      userProfile.preferences.responseLength,
      currentAnalysis.guidance.length
    );

    return {
      systemPromptAdditions,
      temperatureAdjustment,
      maxTokensAdjustment,
      emojiGuidelines,
      toneGuidelines,
      lengthGuidelines,
    };
  }

  @bindThis
  private getTimeBasedAdjustments(hour: number): string[] {
    const adjustments: string[] = [];

    if (hour >= 5 && hour < 10) {
      adjustments.push('朝の挨拶を含め、爽やかで前向きな応答をしてください。');
    } else if (hour >= 10 && hour < 12) {
      adjustments.push('活発で生産的な雰囲気の応答をしてください。');
    } else if (hour >= 12 && hour < 14) {
      adjustments.push('昼食時間を意識した軽やかな応答をしてください。');
    } else if (hour >= 14 && hour < 17) {
      adjustments.push('午後の集中力を保つような応答をしてください。');
    } else if (hour >= 17 && hour < 20) {
      adjustments.push('一日の疲れを癒すような温かい応答をしてください。');
    } else if (hour >= 20 && hour < 23) {
      adjustments.push('リラックスした雰囲気の応答をしてください。');
    } else {
      adjustments.push('深夜なので、静かで落ち着いた応答をしてください。');
    }

    return adjustments;
  }

  @bindThis
  private getEmotionBasedAdjustments(analysis: ConversationAnalysis): string[] {
    const adjustments: string[] = [];
    const emotions = analysis.emotion.emotions;

    if (emotions.joy > 0.7) {
      adjustments.push('ユーザーの喜びに共感し、一緒に喜ぶような応答をしてください。');
    } else if (emotions.sadness > 0.7) {
      adjustments.push('優しく寄り添い、慰めるような応答をしてください。');
    } else if (emotions.anger > 0.7) {
      adjustments.push('冷静で理解を示す応答をしてください。');
    } else if (emotions.fear > 0.7) {
      adjustments.push('安心感を与え、サポートするような応答をしてください。');
    } else if (emotions.surprise > 0.7) {
      adjustments.push('驚きを共有し、興味深く応答してください。');
    } else if (emotions.love > 0.7) {
      adjustments.push('温かく親密な雰囲気の応答をしてください。');
    }

    return adjustments;
  }

  @bindThis
  private getEmojiGuidelines(emojiUsage: string): string {
    switch (emojiUsage) {
      case 'never':
        return '絵文字は一切使用しないでください。';
      case 'rarely':
        return '絵文字は最小限に抑え、重要な感情表現のみに使用してください。';
      case 'sometimes':
        return '適度に絵文字を使用し、メッセージを親しみやすくしてください。';
      case 'often':
        return '積極的に絵文字を使用し、感情豊かな応答をしてください。';
      case 'always':
        return '各メッセージに必ず絵文字を含め、視覚的に楽しい応答をしてください。';
      default:
        return '状況に応じて適切に絵文字を使用してください。';
    }
  }

  @bindThis
  private getToneGuidelines(tone: string, preferences: UserProfile['preferences']): string {
    const baseGuidelines: Record<string, string> = {
      friendly: '親しみやすく温かい口調で',
      professional: 'プロフェッショナルで信頼感のある口調で',
      casual: 'カジュアルでリラックスした口調で',
      empathetic: '共感的で理解を示す口調で',
      humorous: 'ユーモアを交えた楽しい口調で',
    };

    let guideline = baseGuidelines[tone] || '適切な口調で';

    // フォーマル度による調整
    if (preferences.formality > 0.7) {
      guideline += '、敬語を正しく使って';
    } else if (preferences.formality < 0.3) {
      guideline += '、タメ口で親しみを込めて';
    }

    return guideline + '応答してください。';
  }

  @bindThis
  private getLengthGuidelines(
    preferredLength: string,
    suggestedLength: string
  ): string {
    // ユーザーの好みを優先し、現在の文脈の提案も考慮
    const length = preferredLength === 'adaptive' ? suggestedLength : preferredLength;

    switch (length) {
      case 'brief':
        return '簡潔に要点をまとめて、1-2文程度で応答してください。';
      case 'moderate':
        return '適度な長さで、必要な情報を含めて3-5文程度で応答してください。';
      case 'detailed':
        return '詳細な説明を含めて、包括的に応答してください。';
      default:
        return '文脈に応じた適切な長さで応答してください。';
    }
  }

  @bindThis
  buildPersonalizedSystemPrompt(
    basePrompt: string,
    style: ResponseStyle
  ): string {
    const additions = [
      ...style.systemPromptAdditions,
      style.emojiGuidelines,
      style.toneGuidelines,
      style.lengthGuidelines,
    ];

    return `${basePrompt}\n\n【パーソナライゼーション指示】\n${additions.join('\n')}`;
  }

  @bindThis
  adjustGenerationConfig(
    baseConfig: any,
    style: ResponseStyle
  ): any {
    return {
      ...baseConfig,
      temperature: Math.max(0, Math.min(1, (baseConfig.temperature || 0.7) + style.temperatureAdjustment)),
      maxOutputTokens: Math.max(100, (baseConfig.maxOutputTokens || 1024) + style.maxTokensAdjustment),
    };
  }

  @bindThis
  analyzeResponseFeedback(
    response: string,
    userReaction: string,
    profile: UserProfile
  ): { adjustments: Partial<UserProfile['preferences']> } {
    // ユーザーの反応から好みを学習
    const adjustments: Partial<UserProfile['preferences']> = {};

    // 応答の長さ分析
    const responseLength = response.length;
    if (userReaction.includes('長い') || userReaction.includes('詳しすぎ')) {
      adjustments.responseLength = 'brief';
    } else if (userReaction.includes('短い') || userReaction.includes('もっと詳しく')) {
      adjustments.responseLength = 'detailed';
    }

    // 絵文字使用の分析
    const emojiCount = (response.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
    if (userReaction.includes('絵文字') && userReaction.includes('多い')) {
      profile.communicationStyle.emojiUsage = 'rarely';
    } else if (userReaction.includes('絵文字') && userReaction.includes('少ない')) {
      profile.communicationStyle.emojiUsage = 'often';
    }

    // フォーマル度の分析
    if (userReaction.includes('堅い') || userReaction.includes('フォーマル')) {
      adjustments.formality = Math.max(0, profile.preferences.formality - 0.1);
    } else if (userReaction.includes('カジュアル') || userReaction.includes('親しみ')) {
      adjustments.formality = Math.min(1, profile.preferences.formality + 0.1);
    }

    return { adjustments };
  }
}