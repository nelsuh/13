# 13 — game page + tournament reminder server. Built on the Mac for linux/amd64,
# shipped to the Usion game host (see game-host-guide). Runs on a read-only root.
FROM node:22-alpine
ENV NODE_ENV=production
# Keeps the heap well inside the container limit (usion.game.json memory_mb: 160).
ENV NODE_OPTIONS=--max-old-space-size=96
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY index.html script.js style.css ./
COPY server/index.mjs server/store.mjs server/usion.mjs ./server/
USER node
EXPOSE 8080
CMD ["node", "server/index.mjs"]
