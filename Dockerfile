FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY migrations ./migrations
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "src/server.js"]
