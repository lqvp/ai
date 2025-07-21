import got from 'got';
import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import type {
  ConversationAnalysis,
  EmotionAnalysis,
  TopicAnalysis,
  IntentClassification,
  MemoryDecision,
  PersonalizationSuggestion,
  ResponseGuidance,
} from './types.js';

interface AnalysisPromptResult {
  emotion: EmotionAnalysis;
  topic: TopicAnalysis;
  intent: IntentClassification;
  memory: MemoryDecision;
  personalization: PersonalizationSuggestion;
  guidance: ResponseGuidance;
}

export class LLMAnalyzer {
  private apiKey: string;
  private model: string;
  private apiUrl: string;

  constructor() {
    this.apiKey = config.gemini?.apiKey || '';
    this.model = config.gemini?.model || 'gemini-2.5-flash';
    this.apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  }

  @bindThis
  async analyzeConversation(
    message: string,
    context: string[],
    userId: string,
    userName?: string
  ): Promise<ConversationAnalysis> {
    const prompt = this.buildAnalysisPrompt(message, context, userName);
    
    try {
      const response = await this.callGeminiAPI(prompt);
      const analysis = this.parseAnalysisResponse(response);
      
      return {
        ...analysis,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error('Error analyzing conversation:', error);
      // フォールバック分析を返す
      return this.getFallbackAnalysis();
    }
  }

  @bindThis
  private buildAnalysisPrompt(
    message: string,
    context: string[],
    userName?: string
  ): string {
    const contextStr = context.length > 0 
      ? `最近の会話履歴:\n${context.join('\n')}\n\n` 
      : '';
    
    const userInfo = userName ? `ユーザー名: ${userName}\n` : '';

    return `あなたは会話分析の専門家です。以下の会話を分析し、JSON形式で結果を返してください。

${userInfo}
${contextStr}
現在のメッセージ: ${message}

以下の観点で分析してください：

1. 感情分析 (emotion):
   - sentiment: "positive", "negative", "neutral" のいずれか
   - confidence: 0-1の数値
   - emotions: 各感情の強さを0-1で評価
     - joy（喜び）
     - sadness（悲しみ）
     - anger（怒り）
     - fear（恐れ）
     - surprise（驚き）
     - love（愛）

2. トピック分析 (topic):
   - mainTopic: メイントピック（日本語）
   - subTopics: サブトピックの配列（日本語）
   - keywords: キーワードの配列（日本語）
   - entities: エンティティ認識
     - people: 人名の配列
     - places: 場所名の配列
     - organizations: 組織名の配列
     - products: 製品名の配列
     - events: イベント名の配列

3. 意図分類 (intent):
   - type: "question", "statement", "request", "greeting", "farewell", "emotion", "other" のいずれか
   - confidence: 0-1の数値
   - subType: より詳細な分類（任意）

4. 記憶判定 (memory):
   - shouldSave: true/false（保存すべきか）
   - importance: 0-1の数値（重要度）
   - category: カテゴリ名（日本語）
   - summary: 要約（日本語、50文字以内）
   - tags: タグの配列（日本語）

5. パーソナライゼーション提案 (personalization):
   - preferredStyle: 好みのスタイル（各項目0-1）
     - formality: フォーマル度
     - emotionalExpression: 感情表現の度合い
     - humor: ユーモアの度合い
     - technicalDepth: 技術的深さ
     - creativity: 創造性
   - adjustments: 推奨される調整の配列（日本語）

6. 応答ガイダンス (guidance):
   - tone: "friendly", "professional", "casual", "empathetic", "humorous" のいずれか
   - length: "brief", "moderate", "detailed" のいずれか
   - useEmoji: true/false
   - emphasisPoints: 強調すべきポイントの配列（日本語）
   - avoidTopics: 避けるべきトピックの配列（日本語）

必ず有効なJSON形式で返答してください。`;
  }

  @bindThis
  private async callGeminiAPI(prompt: string): Promise<string> {
    const requestBody = {
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.3,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
      }
    };

private async callGeminiAPI(prompt: string): Promise<string> {
  const maxRetries = 3;
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const requestBody = {
        // ... existing code
      };

      const response = await got
        .post(this.apiUrl, {
          searchParams: { key: this.apiKey },
          json: requestBody,
          timeout: { request: 30000 },
        })
        .json<any>();

      return response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        // 指数バックオフで待機
        const delayMs = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

  @bindThis
  private parseAnalysisResponse(response: string): AnalysisPromptResult {
    try {
      const parsed = JSON.parse(response);
      return this.validateAnalysisResult(parsed);
    } catch (error) {
      console.error('Error parsing analysis response:', error);
      return this.getDefaultAnalysis();
    }
  }

  @bindThis
  private validateAnalysisResult(result: any): AnalysisPromptResult {
    // 各フィールドの検証とデフォルト値の設定
    const validated: AnalysisPromptResult = {
      emotion: this.validateEmotionAnalysis(result.emotion),
      topic: this.validateTopicAnalysis(result.topic),
      intent: this.validateIntentClassification(result.intent),
      memory: this.validateMemoryDecision(result.memory),
      personalization: this.validatePersonalizationSuggestion(result.personalization),
      guidance: this.validateResponseGuidance(result.guidance),
    };

    return validated;
  }

  @bindThis
  private validateEmotionAnalysis(emotion: any): EmotionAnalysis {
    if (!emotion || typeof emotion !== 'object') {
      return this.getDefaultEmotionAnalysis();
    }

    return {
      sentiment: ['positive', 'negative', 'neutral'].includes(emotion.sentiment) 
        ? emotion.sentiment 
        : 'neutral',
      confidence: this.validateNumber(emotion.confidence, 0, 1, 0.5),
      emotions: {
        joy: this.validateNumber(emotion.emotions?.joy, 0, 1, 0),
        sadness: this.validateNumber(emotion.emotions?.sadness, 0, 1, 0),
        anger: this.validateNumber(emotion.emotions?.anger, 0, 1, 0),
        fear: this.validateNumber(emotion.emotions?.fear, 0, 1, 0),
        surprise: this.validateNumber(emotion.emotions?.surprise, 0, 1, 0),
        love: this.validateNumber(emotion.emotions?.love, 0, 1, 0),
      },
    };
  }

  @bindThis
  private validateTopicAnalysis(topic: any): TopicAnalysis {
    if (!topic || typeof topic !== 'object') {
      return this.getDefaultTopicAnalysis();
    }

    return {
      mainTopic: topic.mainTopic || '一般的な会話',
      subTopics: Array.isArray(topic.subTopics) ? topic.subTopics : [],
      keywords: Array.isArray(topic.keywords) ? topic.keywords : [],
      entities: {
        people: Array.isArray(topic.entities?.people) ? topic.entities.people : [],
        places: Array.isArray(topic.entities?.places) ? topic.entities.places : [],
        organizations: Array.isArray(topic.entities?.organizations) ? topic.entities.organizations : [],
        products: Array.isArray(topic.entities?.products) ? topic.entities.products : [],
        events: Array.isArray(topic.entities?.events) ? topic.entities.events : [],
      },
    };
  }

  @bindThis
  private validateIntentClassification(intent: any): IntentClassification {
    if (!intent || typeof intent !== 'object') {
      return this.getDefaultIntentClassification();
    }

    const validTypes = ['question', 'statement', 'request', 'greeting', 'farewell', 'emotion', 'other'];
    
    return {
      type: validTypes.includes(intent.type) ? intent.type : 'other',
      confidence: this.validateNumber(intent.confidence, 0, 1, 0.5),
      subType: intent.subType,
    };
  }

  @bindThis
  private validateMemoryDecision(memory: any): MemoryDecision {
    if (!memory || typeof memory !== 'object') {
      return this.getDefaultMemoryDecision();
    }

    return {
      shouldSave: Boolean(memory.shouldSave),
      importance: this.validateNumber(memory.importance, 0, 1, 0.3),
      category: memory.category || '一般',
      summary: memory.summary || '',
      tags: Array.isArray(memory.tags) ? memory.tags : [],
    };
  }

  @bindThis
  private validatePersonalizationSuggestion(personalization: any): PersonalizationSuggestion {
    if (!personalization || typeof personalization !== 'object') {
      return this.getDefaultPersonalizationSuggestion();
    }

    return {
      preferredStyle: {
        formality: this.validateNumber(personalization.preferredStyle?.formality, 0, 1, 0.5),
        emotionalExpression: this.validateNumber(personalization.preferredStyle?.emotionalExpression, 0, 1, 0.5),
        humor: this.validateNumber(personalization.preferredStyle?.humor, 0, 1, 0.3),
        technicalDepth: this.validateNumber(personalization.preferredStyle?.technicalDepth, 0, 1, 0.5),
        creativity: this.validateNumber(personalization.preferredStyle?.creativity, 0, 1, 0.5),
      },
      adjustments: Array.isArray(personalization.adjustments) ? personalization.adjustments : [],
    };
  }

  @bindThis
  private validateResponseGuidance(guidance: any): ResponseGuidance {
    if (!guidance || typeof guidance !== 'object') {
      return this.getDefaultResponseGuidance();
    }

    const validTones = ['friendly', 'professional', 'casual', 'empathetic', 'humorous'];
    const validLengths = ['brief', 'moderate', 'detailed'];

    return {
      tone: validTones.includes(guidance.tone) ? guidance.tone : 'friendly',
      length: validLengths.includes(guidance.length) ? guidance.length : 'moderate',
      useEmoji: Boolean(guidance.useEmoji),
      emphasisPoints: Array.isArray(guidance.emphasisPoints) ? guidance.emphasisPoints : [],
      avoidTopics: Array.isArray(guidance.avoidTopics) ? guidance.avoidTopics : [],
    };
  }

  @bindThis
  private validateNumber(value: any, min: number, max: number, defaultValue: number): number {
    const num = Number(value);
    if (isNaN(num)) return defaultValue;
    return Math.max(min, Math.min(max, num));
  }

  @bindThis
  private getDefaultAnalysis(): AnalysisPromptResult {
    return {
      emotion: this.getDefaultEmotionAnalysis(),
      topic: this.getDefaultTopicAnalysis(),
      intent: this.getDefaultIntentClassification(),
      memory: this.getDefaultMemoryDecision(),
      personalization: this.getDefaultPersonalizationSuggestion(),
      guidance: this.getDefaultResponseGuidance(),
    };
  }

  @bindThis
  private getDefaultEmotionAnalysis(): EmotionAnalysis {
    return {
      sentiment: 'neutral',
      confidence: 0.5,
      emotions: {
        joy: 0,
        sadness: 0,
        anger: 0,
        fear: 0,
        surprise: 0,
        love: 0,
      },
    };
  }

  @bindThis
  private getDefaultTopicAnalysis(): TopicAnalysis {
    return {
      mainTopic: '一般的な会話',
      subTopics: [],
      keywords: [],
      entities: {
        people: [],
        places: [],
        organizations: [],
        products: [],
        events: [],
      },
    };
  }

  @bindThis
  private getDefaultIntentClassification(): IntentClassification {
    return {
      type: 'other',
      confidence: 0.5,
    };
  }

  @bindThis
  private getDefaultMemoryDecision(): MemoryDecision {
    return {
      shouldSave: false,
      importance: 0.3,
      category: '一般',
      summary: '',
      tags: [],
    };
  }

  @bindThis
  private getDefaultPersonalizationSuggestion(): PersonalizationSuggestion {
    return {
      preferredStyle: {
        formality: 0.5,
        emotionalExpression: 0.5,
        humor: 0.3,
        technicalDepth: 0.5,
        creativity: 0.5,
      },
      adjustments: [],
    };
  }

  @bindThis
  private getDefaultResponseGuidance(): ResponseGuidance {
    return {
      tone: 'friendly',
      length: 'moderate',
      useEmoji: true,
      emphasisPoints: [],
      avoidTopics: [],
    };
  }

  @bindThis
  private getFallbackAnalysis(): ConversationAnalysis {
    return {
      ...this.getDefaultAnalysis(),
      timestamp: new Date(),
    };
  }
}