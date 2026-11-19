FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace=frontend --include=optional
COPY frontend frontend
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_VERSION
ARG NEXT_PUBLIC_EURC_ADDRESS
ARG NEXT_PUBLIC_FUTURENET_STREAM_CONTRACT_ID
ARG NEXT_PUBLIC_MAINNET_STREAM_CONTRACT_ID
ARG NEXT_PUBLIC_NETWORK_PASSPHRASE
ARG NEXT_PUBLIC_SANDBOX_HORIZON_URL
ARG NEXT_PUBLIC_SANDBOX_RPC_URL
ARG NEXT_PUBLIC_SANDBOX_STREAM_CONTRACT_ID
ARG NEXT_PUBLIC_SOROBAN_RPC_URL
ARG NEXT_PUBLIC_SSE_URL
ARG NEXT_PUBLIC_STELLAR_EXPERT_URL
ARG NEXT_PUBLIC_STELLAR_HORIZON_URL
ARG NEXT_PUBLIC_STELLAR_NETWORK
ARG NEXT_PUBLIC_STREAMING_CONTRACT
ARG NEXT_PUBLIC_STREAM_CONTRACT_ID
ARG NEXT_PUBLIC_USDC_ADDRESS
ARG NEXT_PUBLIC_VERCEL_ENV
ARG NEXT_PUBLIC_XLM_ADDRESS
ENV FLOWFI_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace=frontend

FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/frontend/.next/standalone ./
COPY --from=build /app/frontend/public ./frontend/public
COPY --from=build /app/frontend/.next/static ./frontend/.next/static
RUN mkdir -p frontend/.next/cache && chown node:node frontend/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK CMD node -e 'fetch("http://127.0.0.1:" + process.env.PORT).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))'
CMD ["node", "frontend/server.js"]
