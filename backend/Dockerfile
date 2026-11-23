FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/

FROM dependencies AS build
RUN npm ci --workspace=backend --include=optional
COPY backend backend
WORKDIR /app/backend
RUN npm run build -- --project tsconfig.build.json

FROM dependencies AS production
RUN npm ci --workspace=backend --omit=dev --ignore-scripts

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runtime
WORKDIR /app/backend
ENV NODE_ENV=production
COPY --from=production /app/node_modules /app/node_modules
COPY --from=production /app/backend /app/backend
COPY --from=build /app/backend/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK CMD node -e 'fetch("http://127.0.0.1:" + (process.env.PORT || 3001) + "/health").then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))'
CMD ["node", "dist/index.js"]
