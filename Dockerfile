# Multi-stage build: the runtime image ships ONLY compiled JS + prod deps.
# WHY: the app container is capped at 256 MB — TypeScript sources, dev
# dependencies and build tools would waste half of it.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Run as non-root: defense in depth if the container is ever compromised.
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
