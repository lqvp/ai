import { bindThis } from '@/decorators.js';
import type { UserMemory, ConversationTopic } from './MemoryManager.js';

export interface SentimentAnalysis {
  sentiment: 'positive' | 'neutral' | 'negative';
  confidence: number;
  emotions: {
    joy: number;
    sadness: number;
    anger: number;
    fear: number;
    surprise: number;
  };
}

export interface TopicExtraction {
  mainTopic: string;
  subTopics: string[];
  entities: Array<{
    text: string;
    type: 'person' | 'place' | 'thing' | 'concept';
  }>;
  isQuestion: boolean;
  questionType?: 'what' | 'why' | 'how' | 'when' | 'where' | 'who' | 'yes-no';
}

export interface ImportantInfo {
  type: 'personal' | 'preference' | 'fact' | 'event' | 'relationship';
  content: string;
  confidence: number;
  tags: string[];
}

/**
 * 会話の文脈を分析するクラス
 */
export default class ContextAnalyzer {
  
  /**
   * 感情分析を実行
   */
  @bindThis
  public analyzeSentiment(text: string): SentimentAnalysis {
    // 感情を表す単語のマッピング
    const emotionKeywords = {
      joy: ['嬉しい', '楽しい', 'ハッピー', '幸せ', '最高', 'わーい', 'やった', '良かった', '素敵', '素晴らしい'],
      sadness: ['悲しい', '辛い', '泣', 'つらい', '寂しい', '切ない', 'しんどい', '憂鬱', '落ち込'],
      anger: ['怒', 'ムカつく', 'イライラ', '腹立つ', 'うざい', 'くそ', '最悪', 'ふざけ'],
      fear: ['怖い', '不安', '心配', '恐', 'びくびく', 'ドキドキ', '緊張'],
      surprise: ['びっくり', '驚', 'まさか', 'えっ', 'すごい', '信じられない', '衝撃']
    };

    const emotions = {
      joy: 0,
      sadness: 0,
      anger: 0,
      fear: 0,
      surprise: 0
    };

    let totalScore = 0;

    // 各感情のスコアを計算
    Object.entries(emotionKeywords).forEach(([emotion, keywords]) => {
      keywords.forEach(keyword => {
        if (text.includes(keyword)) {
          emotions[emotion as keyof typeof emotions] += 1;
          totalScore += 1;
        }
      });
    });

    // スコアを正規化
    if (totalScore > 0) {
      Object.keys(emotions).forEach(emotion => {
        emotions[emotion as keyof typeof emotions] /= totalScore;
      });
    }

    // 全体的な感情を判定
    let sentiment: 'positive' | 'neutral' | 'negative' = 'neutral';
    let confidence = 0.5;

    if (emotions.joy > 0.4) {
      sentiment = 'positive';
      confidence = emotions.joy;
    } else if (emotions.sadness > 0.3 || emotions.anger > 0.3 || emotions.fear > 0.3) {
      sentiment = 'negative';
      confidence = Math.max(emotions.sadness, emotions.anger, emotions.fear);
    }

    // 絵文字による感情の補正
    const positiveEmojis = ['😊', '😄', '🥰', '💕', '✨', '🎉', '👍'];
    const negativeEmojis = ['😢', '😭', '😡', '😰', '💔', '👎'];

    positiveEmojis.forEach(emoji => {
      if (text.includes(emoji)) {
        sentiment = 'positive';
        confidence = Math.min(1, confidence + 0.2);
      }
    });

    negativeEmojis.forEach(emoji => {
      if (text.includes(emoji)) {
        sentiment = 'negative';
        confidence = Math.min(1, confidence + 0.2);
      }
    });

    return {
      sentiment,
      confidence,
      emotions
    };
  }

  /**
   * トピックを抽出
   */
  @bindThis
  public extractTopic(text: string): TopicExtraction {
    // 質問パターンの検出
    const questionPatterns = {
      'what': ['何', 'なに', 'どんな', 'どういう'],
      'why': ['なぜ', 'どうして', 'なんで'],
      'how': ['どう', 'どのように', 'どうやって'],
      'when': ['いつ', 'いつから', 'いつまで'],
      'where': ['どこ', 'どちら'],
      'who': ['誰', 'だれ', 'どなた'],
      'yes-no': ['ですか', 'ますか', 'の？', 'かな？']
    };

    let isQuestion = false;
    let questionType: TopicExtraction['questionType'] = undefined;

    // 質問タイプの判定
    for (const [type, patterns] of Object.entries(questionPatterns)) {
      if (patterns.some(pattern => text.includes(pattern))) {
        isQuestion = true;
        questionType = type as TopicExtraction['questionType'];
        break;
      }
    }

    // エンティティの抽出（簡易版）
    const entities: TopicExtraction['entities'] = [];

    // 人名パターン（「〜さん」「〜君」「〜ちゃん」）
    const personPatterns = text.match(/(\S+)(さん|君|ちゃん)/g);
    if (personPatterns) {
      personPatterns.forEach(match => {
        entities.push({ text: match, type: 'person' });
      });
    }

    // 場所パターン（「〜で」「〜に」の前の名詞）
    const placePatterns = text.match(/(\S+)(で|に|へ)/g);
    if (placePatterns) {
      placePatterns.forEach(match => {
        const place = match.slice(0, -1);
        if (!entities.some(e => e.text === place)) {
          entities.push({ text: place, type: 'place' });
        }
      });
    }

    // キーワード抽出
    const keywords = this.extractKeywords(text);
    const mainTopic = keywords[0] || '';
    const subTopics = keywords.slice(1);

    return {
      mainTopic,
      subTopics,
      entities,
      isQuestion,
      questionType
    };
  }

  /**
   * 重要な情報を抽出
   */
  @bindThis
  public extractImportantInfo(text: string, context?: { 
    previousMessages?: string[],
    userMemories?: UserMemory[]
  }): ImportantInfo[] {
    const importantInfoList: ImportantInfo[] = [];

    // 個人情報パターン
    const personalPatterns = [
      { regex: /私の名前は(\S+)/, type: 'personal' as const, tag: 'name' },
      { regex: /(\d+)歳/, type: 'personal' as const, tag: 'age' },
      { regex: /誕生日は(\S+)/, type: 'personal' as const, tag: 'birthday' },
      { regex: /(\S+)に住んで/, type: 'personal' as const, tag: 'location' },
      { regex: /仕事は(\S+)/, type: 'personal' as const, tag: 'job' }
    ];

    // 好みパターン
    const preferencePatterns = [
      { regex: /(\S+)が好き/, type: 'preference' as const, tag: 'like' },
      { regex: /(\S+)が嫌い/, type: 'preference' as const, tag: 'dislike' },
      { regex: /(\S+)が苦手/, type: 'preference' as const, tag: 'weakness' },
      { regex: /(\S+)が得意/, type: 'preference' as const, tag: 'strength' }
    ];

    // イベントパターン
    const eventPatterns = [
      { regex: /今日は(\S+)/, type: 'event' as const, tag: 'today' },
      { regex: /明日(\S+)/, type: 'event' as const, tag: 'tomorrow' },
      { regex: /(\S+)の予定/, type: 'event' as const, tag: 'schedule' },
      { regex: /(\S+)に行く/, type: 'event' as const, tag: 'plan' }
    ];

    // パターンマッチング
    [...personalPatterns, ...preferencePatterns, ...eventPatterns].forEach(pattern => {
      const match = text.match(pattern.regex);
      if (match) {
        importantInfoList.push({
          type: pattern.type,
          content: match[0],
          confidence: 0.8,
          tags: [pattern.tag]
        });
      }
    });

    // 関係性の検出
    if (text.includes('友達') || text.includes('友人')) {
      importantInfoList.push({
        type: 'relationship',
        content: text,
        confidence: 0.7,
        tags: ['friendship']
      });
    }

    // 文脈を考慮した重要度の調整
    if (context?.previousMessages) {
      importantInfoList.forEach(info => {
        // 以前のメッセージで言及されていない新しい情報は重要度を上げる
        const isNew = !context.previousMessages!.some(msg => 
          msg.includes(info.content.split(/[はがをに]/)[0])
        );
        if (isNew) {
          info.confidence = Math.min(1, info.confidence + 0.2);
        }
      });
    }

    return importantInfoList;
  }

  /**
   * 会話の継続性を分析
   */
  @bindThis
  public analyzeContinuity(
    currentMessage: string,
    previousTopic?: ConversationTopic
  ): {
    isContinuation: boolean;
    topicShift: number; // 0-1 (0: 同じトピック, 1: 完全に違うトピック)
    transitionType: 'smooth' | 'abrupt' | 'related' | 'new';
  } {
    if (!previousTopic) {
      return {
        isContinuation: false,
        topicShift: 1,
        transitionType: 'new'
      };
    }

    const currentKeywords = this.extractKeywords(currentMessage);
    const commonKeywords = currentKeywords.filter(kw => 
      previousTopic.keywords.includes(kw)
    );

    const overlapRatio = commonKeywords.length / Math.max(currentKeywords.length, 1);
    const topicShift = 1 - overlapRatio;

    let transitionType: 'smooth' | 'abrupt' | 'related' | 'new';
    if (overlapRatio > 0.5) {
      transitionType = 'smooth';
    } else if (overlapRatio > 0.2) {
      transitionType = 'related';
    } else if (overlapRatio > 0) {
      transitionType = 'abrupt';
    } else {
      transitionType = 'new';
    }

    return {
      isContinuation: overlapRatio > 0.2,
      topicShift,
      transitionType
    };
  }

  /**
   * レスポンスの優先度を決定
   */
  @bindThis
  public determinePriority(analysis: {
    sentiment: SentimentAnalysis;
    topic: TopicExtraction;
    importantInfo: ImportantInfo[];
    continuity?: ReturnType<ContextAnalyzer['analyzeContinuity']>;
  }): {
    priority: 'high' | 'medium' | 'low';
    reason: string;
    suggestedResponseType: 'immediate' | 'thoughtful' | 'casual';
  } {
    let priority: 'high' | 'medium' | 'low' = 'medium';
    let reason = '';
    let suggestedResponseType: 'immediate' | 'thoughtful' | 'casual' = 'thoughtful';

    // 感情的な緊急性
    if (analysis.sentiment.sentiment === 'negative' && analysis.sentiment.confidence > 0.7) {
      priority = 'high';
      reason = 'ユーザーがネガティブな感情を示している';
      suggestedResponseType = 'immediate';
    }

    // 質問への対応
    if (analysis.topic.isQuestion) {
      if (priority !== 'high') priority = 'medium';
      reason = reason || 'ユーザーが質問をしている';
      suggestedResponseType = 'thoughtful';
    }

    // 重要な情報の共有
    if (analysis.importantInfo.length > 0 && analysis.importantInfo.some(info => info.confidence > 0.8)) {
      priority = 'high';
      reason = 'ユーザーが重要な個人情報を共有している';
      suggestedResponseType = 'thoughtful';
    }

    // 会話の継続性
    if (analysis.continuity?.transitionType === 'abrupt') {
      if (priority === 'low') priority = 'medium';
      reason = reason || '話題が急に変わった';
      suggestedResponseType = 'thoughtful';
    }

    // デフォルト
    if (!reason) {
      priority = 'low';
      reason = '通常の会話';
      suggestedResponseType = 'casual';
    }

    return {
      priority,
      reason,
      suggestedResponseType
    };
  }

  /**
   * キーワード抽出（MemoryManagerと同じだが、より高度な実装）
   */
  @bindThis
  private extractKeywords(text: string): string[] {
    const stopWords = [
      'の', 'は', 'が', 'を', 'に', 'で', 'と', 'から', 'まで', 'や', 'も',
      'です', 'ます', 'でした', 'ました', 'だ', 'である', 'こと', 'もの',
      'これ', 'それ', 'あれ', 'この', 'その', 'あの', 'ここ', 'そこ', 'あそこ'
    ];

    // 句読点で分割してから、さらに助詞で分割
    const words = text
      .split(/[、。！？\n\s]+/)
      .flatMap(segment => segment.split(/[はがをにでと]/))
      .filter(word => word.length > 1)
      .filter(word => !stopWords.includes(word));

    // 重要度でスコアリング
    const scored = words.map(word => {
      let score = 1;
      
      // カタカナは重要
      if (/^[\u30A0-\u30FF]+$/.test(word)) score += 2;
      
      // 漢字を含むは重要
      if (/[\u4E00-\u9FAF]/.test(word)) score += 1.5;
      
      // 英語（大文字始まり）は重要
      if (/^[A-Z]/.test(word)) score += 1.5;
      
      // 数字を含むは重要
      if (/\d/.test(word)) score += 1;
      
      // 長い単語は重要
      if (word.length > 3) score += 0.5;
      
      return { word, score };
    });

    // スコア順にソートして重複を除去
    return [...new Set(scored.sort((a, b) => b.score - a.score).map(item => item.word))].slice(0, 10);
  }
}