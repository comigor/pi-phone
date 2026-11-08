FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org/ && npm cache clean --force

COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8091 8092
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
