FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org/ && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8091 8092
CMD ["node", "server/index.js"]
