FROM node:lts

RUN apt-get update && apt-get install tini --no-install-recommends -y && apt-get clean && rm -rf /var/lib/apt-get/lists/*

ARG enable_mecab=1

RUN if [ $enable_mecab -ne 0 ]; then apt-get update \
  && apt-get install mecab libmecab-dev mecab-ipadic-utf8 make curl xz-utils file sudo --no-install-recommends -y \
  && apt-get clean \
  && rm -rf /var/lib/apt-get/lists/* \
  && cd /opt \
  && git clone --depth 1 https://github.com/yokomotod/mecab-ipadic-neologd.git \
  && cd /opt/mecab-ipadic-neologd \
  && ./bin/install-mecab-ipadic-neologd -n -y \
  && rm -rf /opt/mecab-ipadic-neologd \
  && echo "dicdir = /usr/lib/x86_64-linux-gnu/mecab/dic/mecab-ipadic-neologd/" > /etc/mecabrc \
  && apt-get purge git make curl xz-utils file -y; fi

# canvasモジュールのビルドに必要な依存パッケージを追加
RUN apt-get update && apt-get install -y \
  build-essential \
  libcairo2-dev \
  libpango1.0-dev \
  libjpeg-dev \
  libgif-dev \
  librsvg2-dev \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# package.json の packageManager と同じバージョンに固定する
RUN npm install -g pnpm@10.18.0

COPY . /ai

WORKDIR /ai

RUN pnpm install --frozen-lockfile --prod=false \
  && pnpm run build \
  && pnpm prune --prod

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
