<h1><p align="center"><img src="./ai.svg" alt="藍" height="200"></p></h1>
<p align="center">An Ai for Misskey. <a href="./torisetu.md">About Ai</a></p>

## [本家と違う部分があります](./torisetu-fork.md)

## これなに
Misskey用の日本語Botです。

## インストール
> Node.js と npm と MeCab (オプション) がインストールされている必要があります。

まず適当なディレクトリに `git clone` します。
次にそのディレクトリに `config.toml` を作成します。中身は次のexampleを参照してください。
（MeCabの設定、memoryDirについてはご自身の環境に合わせてください）

https://github.com/lqvp/ai/blob/master/example.config.toml

`pnpm install` して `pnpm build` して `pnpm start` すれば起動できます

## Dockerで動かす
まず適当なディレクトリに `git clone` します。
次にそのディレクトリに `config.toml` を作成します。中身は次のexampleを参照してください。
（MeCabの設定、memoryDirについては触らないでください）

https://github.com/lqvp/ai/blob/master/example.config.toml

`docker-compose build` して `docker-compose up` すれば起動できます。
`docker-compose.yml` の `enable_mecab` を `0` にすると、MeCabをインストールしないようにもできます。（メモリが少ない環境など）

## フォント
一部の機能にはフォントが必要です。藍にはフォントは同梱されていないので、ご自身でフォントをインストールディレクトリに`font.ttf`という名前で設置してください。

## 記憶の保持
藍は記憶の保持にSQLiteデータベースを使用しており、藍のインストールディレクトリに `ai.db` という名前で永続化されます。
初回起動時、もし `memory.json` が存在する場合は自動的にSQLiteへマイグレーションされます。

## ライセンス
MIT

## Awards
<img src="./WorksOnMyMachine.png" alt="Works on my machine" height="120">
