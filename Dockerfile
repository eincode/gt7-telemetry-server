FROM node:22-alpine AS builder

WORKDIR /app

# Enable corepack so the right yarn version is used
RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Copy compiled output and production node_modules from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
