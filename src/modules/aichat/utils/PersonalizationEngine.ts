import { bindThis } from '@/decorators.js';
import type { UserPreference } from './MemoryManager.js';

export interface PersonalityProfile {
  formality: number; // 0-1 (0: カジュアル, 1: フォーマル)
  emotiveness: number; // 0-1 (0: 控えめ, 1: 感情豊か)
  verbosity: number; // 0-1 (0: 簡潔, 1: 詳細)
  technicality: number; // 0-1 (0: 初心者向け, 1: 専門的)
  humor: number; // 0-1 (0: 真面目, 1: ユーモラス)
}

export interface ResponseStyle {
  useEmoji: boolean;
  useHonorific: boolean;
  sentenceEndings: string[];
  greetingStyle: 'casual' | 'polite' | 'friendly';
  explanationDepth: 'simple' | 'moderate' | 'detailed';
}

/**
 * ユーザーごとにパーソナライズされた応答を生成するエンジン
 */
export default class PersonalizationEngine {
  private defaultProfile: PersonalityProfile = {
    formality: 0.5,
    emotiveness: 0.7,
    verbosity: 0.5,
    technicality: 0.3,
    humor: 0.4
  };

  /**
   * ユーザーの好みから性格プロファイルを生成
   */
  @bindThis
  public generateProfile(preferences: UserPreference[]): PersonalityProfile {
    const profile = { ...this.defaultProfile };

    preferences.forEach(pref => {
      switch (pref.category) {
        case 'communication_style':
          if (pref.preference === 'formal') {
            profile.formality += pref.confidence * 0.3;
          } else if (pref.preference === 'casual') {
            profile.formality -= pref.confidence * 0.3;
          }
          break;

        case 'emoji_usage':
          if (pref.preference === 'frequent') {
            profile.emotiveness += pref.confidence * 0.2;
          } else if (pref.preference === 'minimal') {
            profile.emotiveness -= pref.confidence * 0.2;
          }
          break;

        case 'explanation_preference':
          if (pref.preference === 'detailed') {
            profile.verbosity += pref.confidence * 0.3;
            profile.technicality += pref.confidence * 0.1;
          } else if (pref.preference === 'concise') {
            profile.verbosity -= pref.confidence * 0.3;
          }
          break;

        case 'humor_preference':
          if (pref.preference === 'enjoy') {
            profile.humor += pref.confidence * 0.3;
          } else if (pref.preference === 'serious') {
            profile.humor -= pref.confidence * 0.3;
          }
          break;

        case 'technical_level':
          if (pref.preference === 'beginner') {
            profile.technicality -= pref.confidence * 0.3;
          } else if (pref.preference === 'advanced') {
            profile.technicality += pref.confidence * 0.3;
          }
          break;
      }
    });

    // 値を0-1の範囲に正規化
    Object.keys(profile).forEach(key => {
      profile[key as keyof PersonalityProfile] = Math.max(0, Math.min(1, profile[key as keyof PersonalityProfile]));
    });

    return profile;
  }

  /**
   * プロファイルから応答スタイルを決定
   */
  @bindThis
  public determineResponseStyle(profile: PersonalityProfile): ResponseStyle {
    return {
      useEmoji: profile.emotiveness > 0.5,
      useHonorific: profile.formality > 0.6,
      sentenceEndings: this.getSentenceEndings(profile),
      greetingStyle: profile.formality > 0.7 ? 'polite' : 
                     profile.emotiveness > 0.6 ? 'friendly' : 'casual',
      explanationDepth: profile.verbosity > 0.7 ? 'detailed' :
                        profile.verbosity > 0.4 ? 'moderate' : 'simple'
    };
  }

  /**
   * 文末表現を決定
   */
  @bindThis
  private getSentenceEndings(profile: PersonalityProfile): string[] {
    const endings: string[] = [];

    if (profile.formality > 0.7) {
      endings.push('です', 'ます', 'でしょう', 'ですね');
    } else if (profile.formality > 0.4) {
      endings.push('ですよ', 'ますね', 'ですよね', 'かもしれません');
    } else {
      endings.push('だよ', 'だね', 'かも', 'よね');
    }

    if (profile.emotiveness > 0.6) {
      endings.push('♪', '！', '〜');
    }

    return endings;
  }

  /**
   * システムプロンプトを生成
   */
  @bindThis
  public generateSystemPrompt(
    basePrompt: string,
    profile: PersonalityProfile,
    style: ResponseStyle,
    userName?: string
  ): string {
    let prompt = basePrompt + '\n\n';

    // 口調の指定
    if (style.useHonorific && userName) {
      prompt += `ユーザーを「${userName}さん」と呼び、丁寧な言葉遣いで応答してください。\n`;
    } else if (userName) {
      prompt += `ユーザーを「${userName}」と呼び、親しみやすい口調で応答してください。\n`;
    }

    // 絵文字の使用
    if (style.useEmoji) {
      prompt += '適度に絵文字を使って感情豊かに表現してください。\n';
    } else {
      prompt += '絵文字は控えめに使用してください。\n';
    }

    // 説明の深さ
    switch (style.explanationDepth) {
      case 'detailed':
        prompt += '詳細で丁寧な説明を心がけ、例を交えて分かりやすく説明してください。\n';
        break;
      case 'simple':
        prompt += '簡潔で要点を押さえた説明を心がけてください。\n';
        break;
      default:
        prompt += '適度な詳しさで、バランスの取れた説明を心がけてください。\n';
    }

    // 技術レベル
    if (profile.technicality < 0.3) {
      prompt += '専門用語は避け、初心者にも分かりやすい言葉を使ってください。\n';
    } else if (profile.technicality > 0.7) {
      prompt += '技術的な詳細も含めて、専門的な説明をしてください。\n';
    }

    // ユーモア
    if (profile.humor > 0.6) {
      prompt += '適度にユーモアを交えて、楽しい会話を心がけてください。\n';
    }

    // 文末表現
    prompt += `文末は主に「${style.sentenceEndings.join('」「')}」などを使用してください。\n`;

    return prompt;
  }

  /**
   * 応答をパーソナライズ
   */
  @bindThis
  public personalizeResponse(
    response: string,
    style: ResponseStyle,
    userName?: string
  ): string {
    let personalizedResponse = response;

    // 名前の置換
    if (userName && style.useHonorific) {
      personalizedResponse = personalizedResponse.replace(
        /あなた/g,
        `${userName}さん`
      );
    } else if (userName) {
      personalizedResponse = personalizedResponse.replace(
        /あなた/g,
        userName
      );
    }

    // 絵文字の追加（必要に応じて）
    if (style.useEmoji && !personalizedResponse.match(/[😀-🙏]/)) {
      // 文末に適切な絵文字を追加
      if (personalizedResponse.includes('嬉しい') || personalizedResponse.includes('楽しい')) {
        personalizedResponse += ' 😊';
      } else if (personalizedResponse.includes('頑張')) {
        personalizedResponse += ' 💪';
      } else if (personalizedResponse.includes('ありがとう')) {
        personalizedResponse += ' 🙏';
      }
    }

    return personalizedResponse;
  }

  /**
   * ユーザーの反応から好みを推測
   */
  @bindThis
  public inferPreferencesFromReaction(
    message: string,
    reaction?: string
  ): Array<{ category: string; preference: string; positive: boolean }> {
    const inferences: Array<{ category: string; preference: string; positive: boolean }> = [];

    // リアクションから推測
    if (reaction) {
      if (['👍', '😊', '❤️', '💕'].includes(reaction)) {
        // ポジティブな反応
        inferences.push({ category: 'current_style', preference: 'satisfied', positive: true });
      } else if (['👎', '😕', '😐'].includes(reaction)) {
        // ネガティブな反応
        inferences.push({ category: 'current_style', preference: 'unsatisfied', positive: false });
      }
    }

    // メッセージ内容から推測
    if (message.includes('もっと詳しく') || message.includes('詳細に')) {
      inferences.push({ category: 'explanation_preference', preference: 'detailed', positive: true });
    } else if (message.includes('簡潔に') || message.includes('短く')) {
      inferences.push({ category: 'explanation_preference', preference: 'concise', positive: true });
    }

    if (message.includes('絵文字') && message.includes('使わないで')) {
      inferences.push({ category: 'emoji_usage', preference: 'minimal', positive: true });
    } else if (message.includes('絵文字') && (message.includes('もっと') || message.includes('使って'))) {
      inferences.push({ category: 'emoji_usage', preference: 'frequent', positive: true });
    }

    if (message.includes('敬語') || message.includes('丁寧に')) {
      inferences.push({ category: 'communication_style', preference: 'formal', positive: true });
    } else if (message.includes('タメ口') || message.includes('カジュアル')) {
      inferences.push({ category: 'communication_style', preference: 'casual', positive: true });
    }

    return inferences;
  }
}