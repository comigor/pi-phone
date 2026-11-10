FROM node:22-bookworm-slim AS plannotator
ARG PLANNOTATOR_VERSION=0.28.60
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    curl -fsSL -o /usr/local/bin/plannotator "https://github.com/backnotprop/plannotator/releases/download/v${PLANNOTATOR_VERSION}/plannotator-linux-x64" && \
    echo "1ded21e09a51516f86e018687ae2527839f376ecfe6eb6002479590c97d1e003  /usr/local/bin/plannotator" | sha256sum -c - && \
    chmod +x /usr/local/bin/plannotator && \
    /usr/local/bin/plannotator --version

FROM node:22-bookworm-slim
ENV NODE_ENV=production GH_CONFIG_DIR=/data/gh
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gh socat && rm -rf /var/lib/apt/lists/*

COPY --from=plannotator /usr/local/bin/plannotator /usr/local/bin/plannotator
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org/ && npm cache clean --force

COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8091 8092 8093
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
