import { bindThis } from '@/decorators.js';
import type 藍 from '@/ai.js';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';
-import config from '@/config.js';
+import { config } from '@/config.js';
import LLMAnalyzer, { AnalysisResult } from './LLMAnalyzer.js';

export interface UserInteraction {
  userId: string;
  message: string;
  response: string;
  timestamp: number;
  reaction?: string;
  sentiment?: string;
  topic?: string;
}

export interface PersonalityDimensions {
  openness: number;          // 新しい経験への開放性
  conscientiousness: number; // 誠実性
  extraversion: number;      // 外向性
  agreeableness: number;     // 協調性
  neuroticism: number;       // 神経症傾向
}

export interface CommunicationPreferences {
  responseLength: 'short' | 'medium' | 'long' | 'adaptive';
  formalityLevel: number; // 0-1
  emotionalExpression: number; // 0-1
  humorLevel: number; // 0-1
  technicalDepth: number; // 0-1
  creativityLevel: number; // 0-1
}

export interface UserPersona {
  userId: string;
  personality: PersonalityDimensions;
  preferences: CommunicationPreferences;
  interests: string[];
  avoidTopics: string[];
  culturalContext?: string;
  languageNuances?: Record<string, any>;
  lastUpdated: number;
}

/**
 * 適応的パーソナライゼーションシステム
 */
export default class AdaptivePersonalization {
  private ai: 藍;
  private analyzer: LLMAnalyzer;
  private llm: ChatGoogleGenerativeAI;
  private personas: Map<string, UserPersona>;
  private interactionHistory: Map<string, UserInteraction[]>;

  constructor(ai: 藍) {
    this.ai = ai;
    this.analyzer = new LLMAnalyzer();
    this.personas = new Map();
    this.interactionHistory = new Map();

    const apiKey = config.gemini?.apiKey || '';
    if (!apiKey) {
      console.warn('Gemini API key is not configured. AdaptivePersonalization features will be disabled.');
    }

    this.llm = new ChatGoogleGenerativeAI({
      model: config.gemini?.model || 'gemini-2.5-flash',
      apiKey: apiKey,
      temperature: 0.4,
    });

    // 定期的にペルソナを更新
    setInterval(() => this.updateAllPersonas(), 60 * 60 * 1000); // 1時間ごと
  }

  /**
   * ユーザーとのインタラクションを記録
   */
  @bindThis
  public async recordInteraction(
    interaction: UserInteraction,
    analysis?: AnalysisResult
  ): Promise<void> {
    const history = this.interactionHistory.get(interaction.userId) || [];
    
    // 分析結果を含めて記録
    const enrichedInteraction = {
      ...interaction,
      sentiment: analysis?.sentiment.type || interaction.sentiment,
      topic: analysis?.topics.main || interaction.topic,
    };

    history.push(enrichedInteraction);
    
    // 最新100件のみ保持
    if (history.length > 100) {
      history.shift();
    }
    
    this.interactionHistory.set(interaction.userId, history);

    // リアルタイムでペルソナを更新
    await this.updatePersona(interaction.userId);
  }

  /**
   * パーソナライズされたシステムプロンプトを生成
   */
  @bindThis
  public async generatePersonalizedPrompt(
    userId: string,
    basePrompt: string,
    context?: {
      currentMood?: string;
      recentTopics?: string[];
      timeOfDay?: string;
    }
  ): Promise<string> {
    const persona = await this.getOrCreatePersona(userId);
    
    const personalityPrompt = this.generatePersonalityPrompt(persona);
    const preferencePrompt = this.generatePreferencePrompt(persona);
    const contextPrompt = context ? this.generateContextPrompt(context) : '';

    // 動的プロンプト生成
    const dynamicPrompt = await this.generateDynamicPrompt(
      userId,
      persona,
      context
    );

    return `${basePrompt}

【パーソナリティ設定】
${personalityPrompt}

【コミュニケーション設定】
${preferencePrompt}

${contextPrompt}

${dynamicPrompt}

これらの設定に基づいて、ユーザーに最適な応答を生成してください。`;
  }

  /**
   * 応答スタイルの推奨
   */
  @bindThis
  public async recommendResponseStyle(
    userId: string,
    message: string,
    analysis: AnalysisResult
  ): Promise<{
    style: Record<string, any>;
    reasoning: string;
  }> {
    const persona = await this.getOrCreatePersona(userId);
    const recentInteractions = this.interactionHistory.get(userId) || [];

    const prompt = PromptTemplate.fromTemplate(`
ユーザーの性格とコミュニケーション履歴に基づいて、最適な応答スタイルを推奨してください。

ユーザーメッセージ: {message}
メッセージの感情: {sentiment}
メッセージの意図: {intent}

ユーザーの性格:
- 開放性: {openness}
- 誠実性: {conscientiousness}
- 外向性: {extraversion}
- 協調性: {agreeableness}
- 神経症傾向: {neuroticism}

現在の好み:
- 応答の長さ: {responseLength}
- フォーマル度: {formalityLevel}
- 感情表現: {emotionalExpression}
- ユーモア: {humorLevel}

最近のインタラクション:
{recentInteractions}

以下のJSON形式で推奨を返してください:
{{
  "style": {{
    "tone": "friendly/professional/empathetic/playful/serious",
    "length": "short/medium/long",
    "formality": 0.0-1.0,
    "emotiveness": 0.0-1.0,
    "humor": 0.0-1.0,
    "creativity": 0.0-1.0,
    "includeEmoji": true/false,
    "includeExamples": true/false,
    "responseStructure": "direct/elaborative/conversational"
  }},
  "reasoning": "推奨理由"
}}
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    try {
      const result = await chain.invoke({
        message,
        sentiment: analysis.sentiment.type,
        intent: analysis.intent.type,
        openness: persona.personality.openness,
        conscientiousness: persona.personality.conscientiousness,
        extraversion: persona.personality.extraversion,
        agreeableness: persona.personality.agreeableness,
        neuroticism: persona.personality.neuroticism,
        responseLength: persona.preferences.responseLength,
        formalityLevel: persona.preferences.formalityLevel,
        emotionalExpression: persona.preferences.emotionalExpression,
        humorLevel: persona.preferences.humorLevel,
        recentInteractions: recentInteractions
          .slice(-3)
          .map(i => `${i.sentiment} - ${i.topic}`)
          .join('\n'),
      });

      return JSON.parse(result);
    } catch (error) {
      console.error('Failed to recommend response style:', error);
      return {
        style: this.getDefaultStyle(),
        reasoning: 'デフォルトスタイルを使用',
      };
    }
  }

  /**
   * ペルソナの更新
   */
  @bindThis
  private async updatePersona(userId: string): Promise<void> {
    const interactions = this.interactionHistory.get(userId) || [];
    
    if (interactions.length < 5) {
      return; // 十分なデータがない
    }

    const existingPersona = this.personas.get(userId);
    const newPersona = await this.analyzePersonality(userId, interactions);

    if (existingPersona) {
      // 既存のペルソナと新しい分析を融合
      this.personas.set(userId, this.mergePersonas(existingPersona, newPersona));
    } else {
      this.personas.set(userId, newPersona);
    }
  }

  /**
   * 性格分析
   */
  @bindThis
  private async analyzePersonality(
    userId: string,
    interactions: UserInteraction[]
  ): Promise<UserPersona> {
    const prompt = PromptTemplate.fromTemplate(`
以下のユーザーインタラクション履歴から、ビッグファイブ性格特性とコミュニケーション好みを分析してください。

インタラクション履歴:
{interactions}

以下のJSON形式で分析結果を返してください:
{{
  "personality": {{
    "openness": 0.0-1.0,
    "conscientiousness": 0.0-1.0,
    "extraversion": 0.0-1.0,
    "agreeableness": 0.0-1.0,
    "neuroticism": 0.0-1.0
  }},
  "preferences": {{
    "responseLength": "short/medium/long/adaptive",
    "formalityLevel": 0.0-1.0,
    "emotionalExpression": 0.0-1.0,
    "humorLevel": 0.0-1.0,
    "technicalDepth": 0.0-1.0,
    "creativityLevel": 0.0-1.0
  }},
  "interests": ["興味のあるトピック"],
  "avoidTopics": ["避けるべきトピック"],
  "culturalContext": "文化的背景（任意）",
  "languageNuances": {{
    "preferredExpressions": ["好む表現"],
    "avoidExpressions": ["避ける表現"]
  }}
}}
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    const interactionSummary = interactions
      .map(i => `[${i.sentiment || 'neutral'}] ${i.message} -> ${i.response} ${i.reaction ? `(${i.reaction})` : ''}`)
      .join('\n');

    try {
      const result = await chain.invoke({
        interactions: interactionSummary,
      });

      const parsed = JSON.parse(result);
      return {
        userId,
        ...parsed,
        lastUpdated: Date.now(),
      };
    } catch (error) {
      console.error('Failed to analyze personality:', error);
      return this.getDefaultPersona(userId);
    }
  }

  /**
   * 動的プロンプト生成
   */
  @bindThis
  private async generateDynamicPrompt(
    userId: string,
    persona: UserPersona,
    context?: any
  ): Promise<string> {
    const recentInteractions = this.interactionHistory.get(userId) || [];
    const recentTopics = recentInteractions
      .slice(-5)
      .map(i => i.topic)
      .filter(Boolean);

    const prompt = PromptTemplate.fromTemplate(`
ユーザーの性格と最近の会話履歴に基づいて、追加の応答ガイドラインを生成してください。

ユーザーの興味: {interests}
最近の話題: {recentTopics}
現在の時間帯: {timeOfDay}
ユーザーの気分: {mood}

簡潔な応答ガイドライン（2-3文）:
`);

    const chain = RunnableSequence.from([
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    try {
      const guidelines = await chain.invoke({
        interests: persona.interests.join(', '),
        recentTopics: recentTopics.join(', '),
        timeOfDay: context?.timeOfDay || '不明',
        mood: context?.currentMood || '通常',
      });

      return `\n【動的ガイドライン】\n${guidelines}`;
    } catch (error) {
      console.error('Failed to generate dynamic prompt:', error);
      return '';
    }
  }

  /**
   * パーソナリティプロンプトの生成
   */
  @bindThis
  private generatePersonalityPrompt(persona: UserPersona): string {
    const traits = [];

    if (persona.personality.openness > 0.7) {
      traits.push('新しいアイデアや経験に対して開放的で好奇心旺盛');
    } else if (persona.personality.openness < 0.3) {
      traits.push('慣れ親しんだものを好み、実用的なアプローチを重視');
    }

    if (persona.personality.conscientiousness > 0.7) {
      traits.push('計画的で詳細を重視し、構造化された情報を好む');
    } else if (persona.personality.conscientiousness < 0.3) {
      traits.push('柔軟で即興的、カジュアルなやり取りを好む');
    }

    if (persona.personality.extraversion > 0.7) {
      traits.push('社交的でエネルギッシュ、活発な会話を楽しむ');
    } else if (persona.personality.extraversion < 0.3) {
      traits.push('控えめで思慮深く、じっくりとした対話を好む');
    }

    if (persona.personality.agreeableness > 0.7) {
      traits.push('協力的で思いやりがあり、調和を重視');
    }

    if (persona.personality.neuroticism > 0.7) {
      traits.push('感情的な配慮が必要で、共感的なアプローチを好む');
    }

    return traits.join('\n');
  }

  /**
   * 好みプロンプトの生成
   */
  @bindThis
  private generatePreferencePrompt(persona: UserPersona): string {
    const prefs = [];

    prefs.push(`応答の長さ: ${this.translateResponseLength(persona.preferences.responseLength)}`);
    prefs.push(`フォーマル度: ${this.getFormalityDescription(persona.preferences.formalityLevel)}`);
    prefs.push(`感情表現: ${this.getEmotionalDescription(persona.preferences.emotionalExpression)}`);
    
    if (persona.preferences.humorLevel > 0.6) {
      prefs.push('ユーモアを交えた応答を好む');
    }

    if (persona.preferences.technicalDepth > 0.7) {
      prefs.push('技術的な詳細や専門用語の使用を歓迎');
    } else if (persona.preferences.technicalDepth < 0.3) {
      prefs.push('シンプルで分かりやすい説明を好む');
    }

    if (persona.preferences.creativityLevel > 0.7) {
      prefs.push('創造的で独創的な応答を評価');
    }

    return prefs.join('\n');
  }

  /**
   * コンテキストプロンプトの生成
   */
  @bindThis
  private generateContextPrompt(context: any): string {
    const contextItems = [];

    if (context.currentMood) {
      contextItems.push(`現在のユーザーの気分: ${context.currentMood}`);
    }

    if (context.timeOfDay) {
      contextItems.push(`現在の時間帯: ${context.timeOfDay}`);
    }

    if (context.recentTopics && context.recentTopics.length > 0) {
      contextItems.push(`最近の話題: ${context.recentTopics.join(', ')}`);
    }

    return contextItems.length > 0
      ? `\n【現在のコンテキスト】\n${contextItems.join('\n')}`
      : '';
  }

  /**
   * ペルソナの取得または作成
   */
  @bindThis
  private async getOrCreatePersona(userId: string): Promise<UserPersona> {
    let persona = this.personas.get(userId);
    
    if (!persona) {
      const interactions = this.interactionHistory.get(userId) || [];
      
      if (interactions.length >= 5) {
        persona = await this.analyzePersonality(userId, interactions);
        this.personas.set(userId, persona);
      } else {
        persona = this.getDefaultPersona(userId);
      }
    }

    return persona;
  }

  /**
   * デフォルトペルソナ
   */
  @bindThis
  private getDefaultPersona(userId: string): UserPersona {
    return {
      userId,
      personality: {
        openness: 0.5,
        conscientiousness: 0.5,
        extraversion: 0.5,
        agreeableness: 0.6,
        neuroticism: 0.4,
      },
      preferences: {
        responseLength: 'medium',
        formalityLevel: 0.5,
        emotionalExpression: 0.5,
        humorLevel: 0.4,
        technicalDepth: 0.5,
        creativityLevel: 0.5,
      },
      interests: [],
      avoidTopics: [],
      lastUpdated: Date.now(),
    };
  }

  /**
   * デフォルトスタイル
   */
  @bindThis
  private getDefaultStyle(): Record<string, any> {
    return {
      tone: 'friendly',
      length: 'medium',
      formality: 0.5,
      emotiveness: 0.5,
      humor: 0.3,
      creativity: 0.5,
      includeEmoji: true,
      includeExamples: false,
      responseStructure: 'conversational',
    };
  }

  /**
   * ペルソナのマージ
   */
  @bindThis
  private mergePersonas(existing: UserPersona, newPersona: UserPersona): UserPersona {
    // 加重平均で既存と新しい分析を融合
    const weight = 0.3; // 新しい分析の重み

    return {
      userId: existing.userId,
      personality: {
        openness: existing.personality.openness * (1 - weight) + newPersona.personality.openness * weight,
        conscientiousness: existing.personality.conscientiousness * (1 - weight) + newPersona.personality.conscientiousness * weight,
        extraversion: existing.personality.extraversion * (1 - weight) + newPersona.personality.extraversion * weight,
        agreeableness: existing.personality.agreeableness * (1 - weight) + newPersona.personality.agreeableness * weight,
        neuroticism: existing.personality.neuroticism * (1 - weight) + newPersona.personality.neuroticism * weight,
      },
      preferences: {
        ...existing.preferences,
        formalityLevel: existing.preferences.formalityLevel * (1 - weight) + newPersona.preferences.formalityLevel * weight,
        emotionalExpression: existing.preferences.emotionalExpression * (1 - weight) + newPersona.preferences.emotionalExpression * weight,
        humorLevel: existing.preferences.humorLevel * (1 - weight) + newPersona.preferences.humorLevel * weight,
        technicalDepth: existing.preferences.technicalDepth * (1 - weight) + newPersona.preferences.technicalDepth * weight,
        creativityLevel: existing.preferences.creativityLevel * (1 - weight) + newPersona.preferences.creativityLevel * weight,
      },
      interests: [...new Set([...existing.interests, ...newPersona.interests])],
      avoidTopics: [...new Set([...existing.avoidTopics, ...newPersona.avoidTopics])],
      culturalContext: newPersona.culturalContext || existing.culturalContext,
      languageNuances: {
        ...existing.languageNuances,
        ...newPersona.languageNuances,
      },
      lastUpdated: Date.now(),
    };
  }

  /**
   * 全ペルソナの更新
   */
  @bindThis
  private async updateAllPersonas(): Promise<void> {
    for (const userId of this.personas.keys()) {
      await this.updatePersona(userId);
    }
  }

  /**
   * 応答長の翻訳
   */
  @bindThis
  private translateResponseLength(length: string): string {
    const translations: Record<string, string> = {
      short: '簡潔',
      medium: '標準',
      long: '詳細',
      adaptive: '状況に応じて調整',
    };
    return translations[length] || length;
  }

  /**
   * フォーマル度の説明
   */
  @bindThis
  private getFormalityDescription(level: number): string {
    if (level > 0.7) return '丁寧でフォーマル';
    if (level < 0.3) return 'カジュアルでフレンドリー';
    return 'バランスの取れた';
  }

  /**
   * 感情表現の説明
   */
  @bindThis
  private getEmotionalDescription(level: number): string {
    if (level > 0.7) return '感情豊かで共感的';
    if (level < 0.3) return '控えめで客観的';
    return '適度な感情表現';
  }
}