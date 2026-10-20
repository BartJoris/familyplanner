# Gezinsplanner — container image
FROM docker.io/library/node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    CONFIG_FILE=/config/config.json \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]
