FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.mjs ./
RUN mkdir -p /tmp/shoplive-online/uploads

ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]
