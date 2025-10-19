import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import { checkNgWord, ngword } from '@/utils/check-ng-word.js';
import Message from '@/message.js';

interface Article {
  title: string;
  url: string;
}

export default class extends Module {
  public readonly name = 'wikipediaRandom';

  @bindThis
  public install() {
    this.post();
    setInterval(this.post, 1000 * 60 * 3);

    return {
      mentionHook: this.mentionHook,
    };
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (msg.text) {
      const keywords = ['wiki', 'ウィキ', 'うぃき'];
      const manyKeywords = ['いっぱい', '沢山', 'たくさん'];

      const lowerCaseText = msg.text.toLowerCase();

      const containsKeyword = keywords.some((keyword) =>
        lowerCaseText.includes(keyword),
      );
      const containsManyKeyword = manyKeywords.some((keyword) =>
        msg.text.includes(keyword),
      );

      if (containsKeyword) {
        const articleCount = containsManyKeyword ? 3 : 1;
        const articles = await this.fetchFilteredArticles(articleCount);

        if (articles && articles.length > 0) {
          const replyText = articles
            .map(
              (article) =>
                `「${article.title}」の記事を読むのはどうでしょうか！\n${article.url}`,
            )
            .join('\n\n');
          msg.reply(replyText, {
            immediate: true,
          });
        } else {
          msg.reply(
            '何だかWikipediaの調子が悪くてなにも見つからなかったです…ごめんなさい～。',
            {
              immediate: true,
            },
          );
        }
        return true;
      }
    }
    return false;
  }

  @bindThis
  private async post() {
    const now = new Date();
    if (now.getHours() !== 8) return;
    const date = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    const data = this.getData();
    if (data.lastPosted == date) return;
    data.lastPosted = date;
    this.setData(data);

    const articles = await this.fetchFilteredArticles(1);
    if (articles && articles.length > 0) {
      const article = articles[0];
      this.log('Posting random Wikipedia article...');

      this.log('Posting...');
      this.ai.post({
        text: `今日は「${article.title}」の記事を読んでみましょう！\n${article.url}`,
      });
    }
  }

  private async fetchFilteredArticles(
    count: number,
  ): Promise<Article[] | null> {
    const URL = 'https://ja.wikipedia.org/w/api.php';
    const RANDOM_PARAMS = new URLSearchParams({
      action: 'query',
      format: 'json',
      list: 'random',
      rnlimit: count.toString(),
      rnnamespace: '0',
    });

    const excludedCategories = ['女優']; // 手動で設定する除外カテゴリ名リスト

    try {
      const articles: Article[] = [];

      while (articles.length < count) {
        const randomResponse = await fetch(
          `${URL}?${RANDOM_PARAMS.toString()}`,
        );
        const randomData = await randomResponse.json();

        for (const articleData of randomData.query.random) {
          const title = articleData.title;

          // タイトルにNGワードが含まれているか確認
          const isSafeTitle = checkNgWord(title);
          if (!isSafeTitle) continue;

          // カテゴリ情報を取得
          const categoryResponse = await fetch(
            `${URL}?${new URLSearchParams({
              action: 'query',
              format: 'json',
              titles: title,
              prop: 'categories',
            }).toString()}`,
          );
          const categoryData = await categoryResponse.json();

          // 型を明示して `page` の内容を安全に取得
          const pages = categoryData.query.pages as Record<
            string,
            { categories?: { title: string }[] }
          >;
          const page = Object.values(pages)[0];
          const categories =
            page.categories?.map((cat) => cat.title.replace('カテゴリ:', '')) ||
            [];

          // 除外カテゴリまたはNGワードカテゴリの確認
          const hasExcludedCategory = categories.some(
            (cat) =>
              excludedCategories.some((excluded) => cat.includes(excluded)) ||
              ngword.some((ng) => cat.includes(ng)), // NGワードと照合
          );
          if (hasExcludedCategory) continue;

          // 有効な記事として追加
          articles.push({
            title,
            url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(title)}`,
          });

          // 取得した記事が目標の数に達したらループを抜ける
          if (articles.length >= count) break;
        }
      }

      return articles.length > 0 ? articles : null;
    } catch (error) {
      console.error('記事の取得中にエラーが発生しました:', error);
      return null;
    }
  }
}
