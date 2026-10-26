FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS builder

WORKDIR /app

# Copy the prisma directory up front so that (a) any future postinstall
# hook from @prisma/client sees the schema, and (b) the prebuild script
# `prisma generate` fired by `npm run build` below can find it. Doing
# the layout this way means the only required write is the generated
# client under src/generated/prisma, which is already covered by the
# later `COPY src ./src` step below + the runner-stage copy.
COPY package*.json ./
COPY prisma ./prisma

RUN npm install

COPY tsconfig.json ./
COPY prisma.config.ts ./
COPY src ./src

RUN npm run build

FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./dist/generated

EXPOSE 3001

USER node

CMD ["node", "dist/index.js"]