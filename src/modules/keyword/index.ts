import loki from 'lokijs';
import config from '@/config/index.js';
import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import { mecab } from './mecab.js';

function kanaToHira(str: string) {
  return str.replace(/[\u30a1-\u30f6]/g, (match) => {
    const chr = match.charCodeAt(0) - 0x60;
    return String.fromCharCode(chr);
  });
}

export default class extends Module {
  public readonly name = 'keyword';

  private learnedKeywords!: loki.Collection<{
    keyword: string;
    learnedAt: number;
  }>;

  @bindThis
  public install() {
    if (!config.keywordEnabled) return false;

    this.learnedKeywords = this.ai.getCollection('_keyword_learnedKeywords', {
      indices: ['keyword'],
    });
    // 既存コレクションが再利用される場合は indices が適用されないため、
    // 旧環境 (userId インデックスのみ) でも keyword インデックスを保証する
    if (!('keyword' in this.learnedKeywords.binaryIndices)) {
      this.learnedKeywords.ensureIndex('keyword');
    }

    this.every(1000 * 60 * 30, this.learn);
    this.every(1000 * 60 * 60 * 24, this.cleanupLearnedKeywords);

    return {};
  }

  /**
   * learnedKeywords は挿入のみだと無制限に成長するため、
   * learnedAt が 30 日超の古いエントリを定期的に削除する。
   */
  @bindThis
  private cleanupLearnedKeywords() {
    const threshold = Date.now() - 1000 * 60 * 60 * 24 * 30;
    const stale = this.learnedKeywords.find({ learnedAt: { $lt: threshold } });
    for (const item of stale) {
      this.learnedKeywords.remove(item);
    }
    if (stale.length > 0) {
      this.log(`Removed ${stale.length} stale learned keywords`);
    }
  }

  @bindThis
  private async learn() {
    let tl: any[];
    try {
      tl = await this.ai.api<any[]>('notes/hybrid-timeline', {
        limit: 30,
      });
    } catch (e) {
      this.log(`Failed to fetch timeline: ${String(e)}`);
      return;
    }

    const interestedNotes = tl.filter(
      (note) =>
        note.userId !== this.ai.account.id &&
        note.text != null &&
        note.cw == null &&
        (note.visibility === 'public' || note.visibility === 'home')
    );

    if (!Array.isArray(interestedNotes)) return;
    let keywords: string[][] = [];

    for (const note of interestedNotes) {
      let tokens: string[][];
      try {
        tokens = await mecab(note.text, config.mecab, config.mecabDic);
      } catch (e) {
        this.log(`Failed to run mecab: ${String(e)}`);
        continue;
      }
      const keywordsInThisNote = tokens.filter(
        (token) => token[2] == '固有名詞' && token[8] != null
      );
      keywords = keywords.concat(keywordsInThisNote);
    }

    if (keywords.length === 0) return;

    const rnd = Math.floor((1 - Math.sqrt(Math.random())) * keywords.length);
    const keyword = keywords.sort((a, b) =>
      a[0].length < b[0].length ? 1 : -1
    )[rnd];

    const exist = this.learnedKeywords.findOne({
      keyword: keyword[0],
    });

    let text: string;

    if (exist) {
      return;
    } else {
      this.learnedKeywords.insertOne({
        keyword: keyword[0],
        learnedAt: Date.now(),
      });

      text = serifs.keyword.learned(keyword[0], kanaToHira(keyword[8]));
    }

    this.ai.post({
      text: text,
    });
  }
}
