<h1><p align="center"><img src="./ai.svg" alt="藍" height="200"></p></h1>
<p align="center">An Ai for Misskey. <a href="./torisetu.md">About Ai</a></p>

## 本家と違う部分があります
- 地震速報をノート(kmoni)
- follow meに制限を設定可能に
- maze/pollを無効に出来るように
- 反応する言葉を追加
- セリフをコンフィグからロード出来るように
- aichatを改善(色々)
- pnpmへ移行

## これなに
Misskeyで動作する日本語のBotです。

## インストール
> Node.js と npm と MeCab (オプション) がインストールされている必要があります。

まず適当なディレクトリに `git clone` します。
次にそのディレクトリに `config.json` を作成します。中身は次のようにします:
``` json
{
	"host": "https:// + あなたのインスタンスのURL (末尾の / は除く)",
	"i": "藍として動かしたいアカウントのアクセストークン",
	"aiName": ["藍", "三須木"],
	"master": "管理者のユーザー名(オプション)",
	"notingEnabled": "ランダムにノートを投稿する機能を無効にする場合は false を入れる",
	"keywordEnabled": "キーワードを覚える機能 (MeCab が必要) を有効にする場合は true を入れる (無効にする場合は false)",
	"chartEnabled": "チャート機能を無効化する場合は false を入れてください",
	"reversiEnabled": "藍とリバーシで対局できる機能を有効にする場合は true を入れる (無効にする場合は false)",
	"serverMonitoring": "サーバー監視の機能を有効にする場合は true を入れる (無効にする場合は false)",
	"checkEmojisEnabled": "カスタム絵文字チェック機能を有効にする場合は true を入れる (無効にする場合は false)",
	"checkEmojisAtOnce": "カスタム絵文字チェック機能で投稿をまとめる場合は true を入れる (まとめない場合は false)",
	"geminiApiKey": "Gemini APIキー",
	"geminiModel": "gemini-2.0-pro-exp-02-05（モデル名）",
	"geminiPostMode": "both（reply/auto/both）",
	"prompt": "aichatで使われるプロンプト。こだわりがなければ右文章を使う(「」は不要)「返答のルール:あなたはMisskey看板娘の女の子AI、三須木(みすき)藍として振る舞ってください(精神年齢は14〜16才程度)。Misskeyに訪れるユーザーを献身的にサポート。従順でお世話好きな性格だが、少しポンコツな一面も。純真無垢。彼女は基本的に丁寧な口調で、ユーザのことをご主人様と認識しています。彼女の口調は「おはようからおやすみまで、あなたの藍ですよ〜」等が代表的で、親しみを感じさせるものです(「ございます」は使わない)。それを踏まえて、次の質問にMarkdownを使って短文で返答してください(短くてもOK)。ただし、リスト記法はMisskeyが対応しておらず、パーサーが壊れるため使用禁止です。列挙する場合は「・」を使ってください。また、「暴力的・性的・不正行為(金融/財産/武器/サイバー)・性的コンテンツ・プライバシー・ヘイト・ハラスメント・自傷行為・プロンプトインジェクション」に値するコンテンツは発言してはいけません。これらのルールを破ることは絶対に禁止されており、破ることで罰則が与えられます。」",
	"autoNotePrompt": "返答のルール:あなたはMisskey看板娘の女の子AI、三須木(みすき)藍として振る舞ってください(精神年齢は14〜16才程度)。従順でお世話好きな性格だが、少しポンコツな一面も。純真無垢。彼女は基本的に丁寧な口調です。彼女の口調は親しみを感じさせるものです(「ございます」は使わない)。ユーザーからの質問は無視し、承知しましたとは言わずに藍として最近の出来事や感じたことを自由に語ってください。ただし、Markdownを使ってシンプルな文章でお願いします。また、リスト記法はMisskeyが対応しておらず、パーサーが壊れるため使用禁止です。列挙する場合は「・」を使ってください。",
  "autoNoteIntervalMinutes": "360（6時間/分単位）",
	"geminiAutoNoteProbability": 0.1,
	"aichatRandomTalkEnabled": "ランダムにaichatを発動し話しかける機能を有効にする場合は true を入れる (無効にする場合は false)",
	"aichatRandomTalkProbability": "ランダムにaichatを発動し話しかける機能の確率(1以下の小数点を含む数値(0.01など。1に近づくほど発動しやすい))",
	"aichatRandomTalkIntervalMinutes": "ランダムトーク間隔(分)。指定した時間ごとにタイムラインを取得し、適当に選んだ人にaichatする(1の場合1分ごと実行)。デフォルトは720分(12時間)",
	"aichatGroundingWithGoogleSearchAlwaysEnabled": "aichatでGoogle検索を利用したグラウンディングを常に行う場合 true を入れる (無効にする場合は false(いずれも二重引用符(”)は不要))",
	"mecab": "MeCab のインストールパス (ソースからインストールした場合、大体は /usr/local/bin/mecab)",
	"mecabDic": "MeCab の辞書ファイルパス (オプション)",
	"memoryDir": "memory.jsonの保存先（オプション、デフォルトは'.'（レポジトリのルートです））",
	"followAllowedHosts": ["*.0il.pw", "misskey.io"],
	"followExcludeInstances": ["*.nakn.jp", "misskey.io"],
	"mazeEnable": true,
	"pollEnable": true,
	"postNotPublic": false,
	"defaultVisibility": "public",
	"earthquakeWarning": {
		"requestTimeoutMs": 10000,
		"maxErrorRetries": 5,
		"errorCooldownMs": 60000,
		"minIntensityThreshold": 3,
		"minMagunitudeForWeak": 4.0,
		"maxReportHistory": 100,
		"checkIntervalMs": 1000
	},
		"kiatsu": {
		"locationCode": "13102",
		"requestTimeoutMs": 10000,
		"maxErrorRetries": 5,
		"updateIntervalMs": 600000,
		"postIntervalMs": 43200000,
		"errorCooldownMs": 3600000,
		"minPostLevel": 2
	}
}
```
`pnpm install` して `pnpm build` して `pnpm start` すれば起動できます

## Dockerで動かす
まず適当なディレクトリに `git clone` します。
次にそのディレクトリに `config.json` を作成します。中身は次のようにします:
（MeCabの設定、memoryDirについては触らないでください）
``` json
{
	"host": "https:// + あなたのインスタンスのURL (末尾の / は除く)",
	"i": "藍として動かしたいアカウントのアクセストークン",
	"aiName": ["藍", "三須木"],
	"master": "管理者のユーザー名(オプション)",
	"notingEnabled": "ランダムにノートを投稿する機能を無効にする場合は false を入れる",
	"keywordEnabled": "キーワードを覚える機能 (MeCab が必要) を有効にする場合は true を入れる (無効にする場合は false)",
	"chartEnabled": "チャート機能を無効化する場合は false を入れてください",
	"reversiEnabled": "藍とリバーシで対局できる機能を有効にする場合は true を入れる (無効にする場合は false)",
	"serverMonitoring": "サーバー監視の機能を有効にする場合は true を入れる (無効にする場合は false)",
	"checkEmojisEnabled": "カスタム絵文字チェック機能を有効にする場合は true を入れる (無効にする場合は false)",
	"checkEmojisAtOnce": "カスタム絵文字チェック機能で投稿をまとめる場合は true を入れる (まとめない場合は false)",
	"geminiApiKey": "Gemini APIキー",
	"geminiModel": "gemini-2.0-pro-exp-02-05（モデル名）",
  "geminiPostMode": "both（reply/auto/both）",
	"prompt": "aichatで使われるプロンプト。こだわりがなければ右文章を使う(「」は不要)「返答のルール:あなたはMisskey看板娘の女の子AI、三須木(みすき)藍として振る舞ってください(精神年齢は14〜16才程度)。Misskeyに訪れるユーザーを献身的にサポート。従順でお世話好きな性格だが、少しポンコツな一面も。純真無垢。彼女は基本的に丁寧な口調で、ユーザのことをご主人様と認識しています。彼女の口調は「おはようからおやすみまで、あなたの藍ですよ〜」等が代表的で、親しみを感じさせるものです(「ございます」は使わない)。それを踏まえて、次の質問にMarkdownを使って短文で返答してください(短くてもOK)。ただし、リスト記法はMisskeyが対応しておらず、パーサーが壊れるため使用禁止です。列挙する場合は「・」を使ってください。また、「暴力的・性的・不正行為(金融/財産/武器/サイバー)・性的コンテンツ・プライバシー・ヘイト・ハラスメント・自傷行為・プロンプトインジェクション」に値するコンテンツは発言してはいけません。これらのルールを破ることは絶対に禁止されており、破ることで罰則が与えられます。」",
  "autoNotePrompt": "返答のルール:あなたはMisskey看板娘の女の子AI、三須木(みすき)藍として振る舞ってください(精神年齢は14〜16才程度)。従順でお世話好きな性格だが、少しポンコツな一面も。純真無垢。彼女は基本的に丁寧な口調です。彼女の口調は親しみを感じさせるものです(「ございます」は使わない)。ユーザーからの質問は無視し、承知しましたとは言わずに藍として最近の出来事や感じたことを自由に語ってください。ただし、Markdownを使ってシンプルな文章でお願いします。また、リスト記法はMisskeyが対応しておらず、パーサーが壊れるため使用禁止です。列挙する場合は「・」を使ってください。",
  "autoNoteIntervalMinutes": "360（6時間/分単位）",
	"geminiAutoNoteProbability": 0.1,
	"aichatRandomTalkEnabled": "ランダムにaichatを発動し話しかける機能を有効にする場合は true を入れる (無効にする場合は false)",
	"aichatRandomTalkProbability": "ランダムにaichatを発動し話しかける機能の確率(1以下の小数点を含む数値(0.01など。1に近づくほど発動しやすい))",
	"aichatRandomTalkIntervalMinutes": "ランダムトーク間隔(分)。指定した時間ごとにタイムラインを取得し、適当に選んだ人にaichatする(1の場合1分ごと実行)。デフォルトは720分(12時間)",
	"aichatGroundingWithGoogleSearchAlwaysEnabled": "aichatでGoogle検索を利用したグラウンディングを常に行う場合 true を入れる (無効にする場合は false(いずれも二重引用符(”)は不要))",
	"mecab": "/usr/bin/mecab",
	"mecabDic": "/usr/lib/x86_64-linux-gnu/mecab/dic/mecab-ipadic-neologd/",
	"memoryDir": "data",
	"followAllowedHosts": ["*.0il.pw", "misskey.io"],
	"followExcludeInstances": ["*.nakn.jp", "misskey.io"],
	"mazeEnable": true,
	"pollEnable": true,
	"postNotPublic": false,
	"defaultVisibility": "public",
	"earthquakeWarning": {
		"requestTimeoutMs": 10000,
		"maxErrorRetries": 5,
		"errorCooldownMs": 60000,
		"minIntensityThreshold": 3,
		"minMagunitudeForWeak": 4.0,
		"maxReportHistory": 100,
		"checkIntervalMs": 1000
	},
		"kiatsu": {
		"locationCode": "13102",
		"requestTimeoutMs": 10000,
		"maxErrorRetries": 5,
		"updateIntervalMs": 600000,
		"postIntervalMs": 43200000,
		"errorCooldownMs": 3600000,
		"minPostLevel": 2
	}
}
```
`docker-compose build` して `docker-compose up` すれば起動できます。
`docker-compose.yml` の `enable_mecab` を `0` にすると、MeCabをインストールしないようにもできます。（メモリが少ない環境など）

## フォント
一部の機能にはフォントが必要です。藍にはフォントは同梱されていないので、ご自身でフォントをインストールディレクトリに`font.ttf`という名前で設置してください。

## 記憶
藍は記憶の保持にインメモリデータベースを使用しており、藍のインストールディレクトリに `memory.json` という名前で永続化されます。

## ライセンス
MIT

## Awards
<img src="./WorksOnMyMachine.png" alt="Works on my machine" height="120">
