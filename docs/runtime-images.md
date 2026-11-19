# Runtime images

Build both application services from the repository root:

```bash
docker build -f backend/Dockerfile -t flowfi-backend .
docker build -f frontend/Dockerfile -t flowfi-frontend \
  --build-arg NEXT_PUBLIC_API_URL=https://api.flowfi.xyz/v1 \
  --build-arg NEXT_PUBLIC_STELLAR_NETWORK=TESTNET .
```

Both images use the digest-pinned Node Alpine base and the root npm lockfile.
For a repeatable build, record the Git revision, target platform, base digest,
lockfile hash, and public frontend build arguments. The build context uses an
allowlist so local environment files and build outputs stay out of the image.

The backend contains compiled application code, the generated Prisma client,
and the backend workspace's production dependencies. Run database migrations
from a checkout as a separate deployment step. Pass the database URL and other
backend configuration at runtime. The backend listens on port 3001, checks
`/health`, and should have at least 65 seconds to drain after SIGTERM.

The frontend contains the Next.js standalone server, traced runtime dependencies,
and the built static and public assets. It listens on port 3000. Public API and
Stellar configuration passed at build time is visible in the browser bundle.
Use the pinned upstream Postgres image in Compose. Soroban contracts deploy as
WASM and the SDK ships as a library.

Run `bash scripts/check-runtime-images.sh` with Docker Compose and the root npm
dependencies installed. CI builds both images, checks startup failure without a
database URL, waits for healthy services, checks their container UIDs, and
requires a successful exit after SIGTERM.
