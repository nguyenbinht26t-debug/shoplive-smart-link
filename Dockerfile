FROM node:22-bookworm-slim AS pot-builder

ARG BGUTIL_POT_VERSION=1.3.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
    && git clone --depth 1 --single-branch --branch "${BGUTIL_POT_VERSION}" \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
      /opt/bgutil-ytdlp-pot-provider \
    && cd /opt/bgutil-ytdlp-pot-provider/server \
    && npm ci \
    && npx tsc \
    && npm prune --omit=dev \
    && rm -rf /opt/bgutil-ytdlp-pot-provider/.git /root/.npm /var/lib/apt/lists/*

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
    && pip3 install --break-system-packages --no-cache-dir -U \
      "yt-dlp[default,curl-cffi]" \
      "bgutil-ytdlp-pot-provider==1.3.1" \
    && rm -rf /var/lib/apt/lists/*

COPY --from=pot-builder /opt/bgutil-ytdlp-pot-provider /opt/bgutil-ytdlp-pot-provider

WORKDIR /app
COPY package.json server.mjs ./
RUN mkdir -p /app/data

ENV HOST=0.0.0.0
ENV PORT=8787
ENV YOUTUBE_PO_PROVIDER_HOME=/opt/bgutil-ytdlp-pot-provider/server
ENV TOKEN_TTL=6
EXPOSE 8787
CMD ["node", "server.mjs"]
