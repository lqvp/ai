<h1><p align="center"><img src="./ai.svg" alt="藍" height="200"></p></h1>
<p align="center">An Ai for Misskey. <a href="./torisetu.md">About Ai</a></p>

## [本家と違う部分があります](./torisetu-fork.md)

## [設定ファイルの移行ガイド](./docs/MIGRATION-GUIDE.md)

## これなに
Misskey用の日本語Botです。

## インストール
> Node.js 22 以上と pnpm 10 と MeCab (オプション) がインストールされている必要があります。

まず適当なディレクトリに `git clone` します。
次にそのディレクトリに `config.toml` を作成します。中身は次のexampleを参照してください。
（MeCabの設定、memoryDirについてはご自身の環境に合わせてください）

https://github.com/lqvp/ai/blob/master/example.config.toml

```sh
corepack enable
pnpm install
pnpm build
pnpm start
```

設定ファイルの場所は `AI_CONFIG` 環境変数でも指定できます（既定: `./config.toml`）。
`config.toml` は起動時に検証され、不正な値があると理由を表示して終了します。

## Dockerで動かす
まず適当なディレクトリに `git clone` します。
次にそのディレクトリに `config.toml` を作成します。中身は次のexampleを参照してください。
（MeCabの設定、memoryDirについては触らないでください）

https://github.com/lqvp/ai/blob/master/example.config.toml

`docker-compose build` して `docker-compose up` すれば起動できます。
`docker-compose.yml` の `enable_mecab` を `0` にすると、MeCabをインストールしないようにもできます。（メモリが少ない環境など）

## 開発

```sh
pnpm dev          # tsc ウォッチ + nodemon
pnpm typecheck    # src と tests の型チェック
pnpm test         # vitest
pnpm lint         # biome check --write
pnpm lint:ci      # CI 用（書き換えなし）
pnpm build        # 本番ビルド（ts-patch で @/ エイリアスを解決）
```

CI (`.github/workflows/ci.yml`) では typecheck / lint / test / build を実行します。

## フォント
一部の機能にはフォントが必要です。藍にはフォントは同梱されていないので、ご自身でフォントをインストールディレクトリに`font.ttf`という名前で設置してください。

## 記憶
藍は記憶の保持にインメモリデータベースを使用しており、藍のインストールディレクトリに `memory.json` という名前で永続化されます。

## ライセンス
MIT

## Awards
<img src="./WorksOnMyMachine.png" alt="Works on my machine" height="120">
