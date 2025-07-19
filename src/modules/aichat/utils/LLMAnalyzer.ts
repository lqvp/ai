import { bindThis } from '@/decorators.js';
import got from 'got';
import config from '@/config.js';

export interface AnalysisResult {
  sentiment: {
    type: 'positive' | 'neutral' | 'negative';
    confidence: number;
    emotions: {
      joy: number;
      sadness: number;
      anger: number;
      fear: number;
      surprise: number;
      love: number;
    };
  };
  topics: {
    main: string;
    sub: string[];
    keywords: string[];
    entities: Array<{
      text: string;
      type: 'person' | 'place' | 'organization' | 'event' | 'product' | 'other';
    }>;
  };
  intent: {
    type: 'question' | 'statement' | 'request' | 'greeting' | 'farewell' | 'other';
    subtype?: string;
    urgency: 'high' | 'medium' | 'low';
  };
  memory: {
    shouldSave: boolean;
    importance: number;
    category: string;
    summary: string;
    relatedMemories?: string[];
  };
  personalization: {
    preferredStyle: {
      formality: number;
      emotiveness: number;
      verbosity: number;
      technicality: number;
      humor: number;
    };
    suggestedAdjustments: string[];
  };
  responseGuidance: {
    tone: string;
    length: 'short' | 'medium' | 'long';
    includeEmoji: boolean;
    focusPoints: string[];
  };
}

/**
 * LLMを使用して会話を統合的に分析するクラス
 */
export default class LLMAnalyzer {
  private apiKey: string;
  private model: string;
  private apiUrl: string;

  constructor() {
    this.apiKey = config.gemini?.apiKey || '';
    this.model = config.gemini?.model || 'gemini-2.5-flash';
    this.apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  }

  /**
   * 会話を統合的に分析
   */
  @bindThis
  public async analyzeConversation(
    message: string,
    context?: {
      previousMessages?: Array<{ role: string; content: string }>;
      userProfile?: any;
      currentTopic?: string;
    }
  ): Promise<AnalysisResult | null> {
    if (!this.apiKey) {
      return null;
    }

    const analysisPrompt = this.buildAnalysisPrompt(message, context);

    try {
      const response = await got.post(this.apiUrl, {
        searchParams: { key: this.apiKey },
        json: {
          contents: [{
            role: 'user',
            parts: [{ text: analysisPrompt }]
          }],
          generationConfig: {
            temperature: 0.3,
            candidateCount: 1,
            responseMimeType: 'application/json'
          }
        },
        responseType: 'json'
      }).json<any>();

      if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
        const analysisText = response.candidates[0].content.parts[0].text;
        return JSON.parse(analysisText) as AnalysisResult;
      }
    } catch (error) {
      console.error('LLM Analysis error:', error);
    }

    return null;
  }

  /**
   * 記憶の検索と関連性分析
   */
  @bindThis
  public async searchMemories(
    query: string,
    memories: Array<{ id: string; content: string; timestamp: number; tags: string[] }>
  ): Promise<Array<{ memory: any; relevance: number; reason: string }>> {
    if (!this.apiKey || memories.length === 0) {
      return [];
    }

    const searchPrompt = `
以下の記憶リストから、クエリ「${query}」に最も関連する記憶を選び、関連度スコア（0-1）と理由を付けて返してください。

記憶リスト:
${memories.map((m, i) => `${i + 1}. [${new Date(m.timestamp).toLocaleDateString()}] ${m.content}`).join('\n')}

JSONフォーマットで返答してください:
{
  "results": [
    {
      "index": 0,
      "relevance": 0.9,
      "reason": "関連する理由"
    }
  ]
}
`;

    try {
      const response = await got.post(this.apiUrl, {
        searchParams: { key: this.apiKey },
        json: {
          contents: [{
            role: 'user',
            parts: [{ text: searchPrompt }]
          }],
          generationConfig: {
            temperature: 0.1,
            candidateCount: 1,
            responseMimeType: 'application/json'
          }
        },
        responseType: 'json'
      }).json<any>();

      if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
        const results = JSON.parse(response.candidates[0].content.parts[0].text);
        return results.results.map((r: any) => ({
          memory: memories[r.index],
          relevance: r.relevance,
          reason: r.reason
        }));
      }
    } catch (error) {
      console.error('Memory search error:', error);
    }

    return [];
  }

  /**
   * パーソナライゼーションの学習
   */
  @bindThis
  public async learnPreferences(
    interactions: Array<{
      message: string;
      response: string;
      reaction?: string;
      timestamp: number;
    }>
  ): Promise<{
    preferences: Record<string, any>;
    insights: string[];
  }> {
    if (!this.apiKey || interactions.length === 0) {
      return { preferences: {}, insights: [] };
    }

    const learningPrompt = `
以下のユーザーとの対話履歴から、ユーザーの好みや特徴を分析してください。

対話履歴:
${interactions.map((i, idx) => `
対話${idx + 1}:
ユーザー: ${i.message}
AI: ${i.response}
${i.reaction ? `リアクション: ${i.reaction}` : ''}
`).join('\n---\n')}

以下のJSON形式で分析結果を返してください:
{
  "preferences": {
    "communicationStyle": "formal/casual/mixed",
    "responseLength": "short/medium/long",
    "emojiUsage": "frequent/moderate/minimal",
    "technicalLevel": "beginner/intermediate/advanced",
    "humorAppreciation": "high/medium/low",
    "topics": ["興味のあるトピック"],
    "avoidTopics": ["避けるべきトピック"]
  },
  "insights": [
    "ユーザーの特徴や好みに関する洞察"
  ]
}
`;

    try {
      const response = await got.post(this.apiUrl, {
        searchParams: { key: this.apiKey },
        json: {
          contents: [{
            role: 'user',
            parts: [{ text: learningPrompt }]
          }],
          generationConfig: {
            temperature: 0.4,
            candidateCount: 1,
            responseMimeType: 'application/json'
          }
        },
        responseType: 'json'
      }).json<any>();

      if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
        return JSON.parse(response.candidates[0].content.parts[0].text);
      }
    } catch (error) {
      console.error('Preference learning error:', error);
    }

    return { preferences: {}, insights: [] };
  }

  /**
   * 分析プロンプトの構築
   */
  @bindThis
  private buildAnalysisPrompt(message: string, context?: any): string {
    let prompt = `
あなたは会話分析の専門家です。以下のメッセージを多角的に分析し、構造化されたJSON形式で結果を返してください。

メッセージ: "${message}"
`;

    if (context?.previousMessages && context.previousMessages.length > 0) {
      prompt += `\n過去の会話:
${context.previousMessages.map(m => `${m.role}: ${m.content}`).join('\n')}
`;
    }

    if (context?.currentTopic) {
      prompt += `\n現在の話題: ${context.currentTopic}`;
    }

    prompt += `

以下の観点で分析し、指定されたJSON形式で返答してください:

{
  "sentiment": {
    "type": "positive/neutral/negative",
    "confidence": 0.0-1.0,
    "emotions": {
      "joy": 0.0-1.0,
      "sadness": 0.0-1.0,
      "anger": 0.0-1.0,
      "fear": 0.0-1.0,
      "surprise": 0.0-1.0,
      "love": 0.0-1.0
    }
  },
  "topics": {
    "main": "メイントピック",
    "sub": ["サブトピック"],
    "keywords": ["重要なキーワード"],
    "entities": [
      {
        "text": "エンティティ名",
        "type": "person/place/organization/event/product/other"
      }
    ]
  },
  "intent": {
    "type": "question/statement/request/greeting/farewell/other",
    "subtype": "具体的な意図（任意）",
    "urgency": "high/medium/low"
  },
  "memory": {
    "shouldSave": true/false,
    "importance": 0.0-1.0,
    "category": "カテゴリ名",
    "summary": "記憶すべき内容の要約",
    "relatedMemories": ["関連する記憶のキーワード"]
  },
  "personalization": {
    "preferredStyle": {
      "formality": 0.0-1.0,
      "emotiveness": 0.0-1.0,
      "verbosity": 0.0-1.0,
      "technicality": 0.0-1.0,
      "humor": 0.0-1.0
    },
    "suggestedAdjustments": ["推奨される調整"]
  },
  "responseGuidance": {
    "tone": "応答のトーン（friendly/professional/empathetic等）",
    "length": "short/medium/long",
    "includeEmoji": true/false,
    "focusPoints": ["応答で重視すべきポイント"]
  }
}

分析は日本語のニュアンスを正確に理解し、文脈を考慮して行ってください。
`;

    return prompt;
  }

  /**
   * 記憶の要約と整理
   */
  @bindThis
  public async summarizeMemories(
    memories: Array<{ content: string; timestamp: number; category: string }>
  ): Promise<{
    summary: string;
    insights: string[];
    suggestedDeletions: number[];
  }> {
    if (!this.apiKey || memories.length === 0) {
      return { summary: '', insights: [], suggestedDeletions: [] };
    }

    const summaryPrompt = `
以下の記憶リストを分析し、要約と洞察を提供してください。また、削除しても良い記憶のインデックスを提案してください。

記憶リスト:
${memories.map((m, i) => `${i}. [${new Date(m.timestamp).toLocaleDateString()}] [${m.category}] ${m.content}`).join('\n')}

JSON形式で返答:
{
  "summary": "全体的な要約",
  "insights": ["得られた洞察"],
  "suggestedDeletions": [削除しても良い記憶のインデックス]
}
`;

    try {
      const response = await got.post(this.apiUrl, {
        searchParams: { key: this.apiKey },
        json: {
          contents: [{
            role: 'user',
            parts: [{ text: summaryPrompt }]
          }],
          generationConfig: {
            temperature: 0.3,
            candidateCount: 1,
            responseMimeType: 'application/json'
          }
        },
        responseType: 'json'
      }).json<any>();

      if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
        return JSON.parse(response.candidates[0].content.parts[0].text);
      }
    } catch (error) {
      console.error('Memory summarization error:', error);
    }

    return { summary: '', insights: [], suggestedDeletions: [] };
  }
}