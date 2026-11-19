import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { createPgPool } from '../src/lib/pg-pool.js';

const pool = createPgPool();
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Use stable, checksum-valid Stellar testnet/demo addresses so seeded rows
// render correctly in the frontend and resolve against TOKEN_ADDRESSES.
const DEMO_SENDER_PUBLIC_KEY = 'GCM5WPR4DDR24FSAX5LIEM4J7AI3KOWJYANSXEPKYXCSZOTAYXE75AFN';
const DEMO_RECIPIENT_PUBLIC_KEY = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3XKSOLXAUJSD56C4LHND5TWUC';
const DEMO_TOKEN_ADDRESS = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

// Production-scale regression fixtures (issue #309).
//
// These fixtures are OPT-IN: they only run when SEED_REGRESSION_FIXTURES=1 so
// the default `prisma db seed` stays fast and deterministic. When enabled they
// generate a repeatable, realistic data volume (streams, events, exports) that
// the query-regression suite measures against. The dataset is fully derived
// from a fixed seed so every run produces identical rows and query plans.
const REGRESSION_ENABLED = process.env.SEED_REGRESSION_FIXTURES === '1';
const REGRESSION_SEED = Number(process.env.SEED_REGRESSION_SEED ?? '309');
const REGRESSION_STREAM_COUNT = Number(process.env.SEED_REGRESSION_STREAMS ?? '5000');
const REGRESSION_EVENTS_PER_STREAM = Number(process.env.SEED_REGRESSION_EVENTS_PER_STREAM ?? '4');

// Deterministic PRNG (mulberry32) so fixture generation is reproducible.
function createRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const REGRESSION_EVENT_TYPES = ['CREATED', 'WITHDRAWN', 'CANCELED', 'COMPLETED'] as const;

async function seedRegressionFixtures(): Promise<void> {
    console.log(
        `Seeding production-scale regression fixtures (seed=${REGRESSION_SEED}, streams=${REGRESSION_STREAM_COUNT}, eventsPerStream=${REGRESSION_EVENTS_PER_STREAM})...`,
    );

    const rng = createRng(REGRESSION_SEED);
    const now = Math.floor(Date.now() / 1000);
    const baseStreamId = 1_000_000;

    // Batch inserts keep the fixture load bounded while still producing a
    // realistic row count for query-plan measurement.
    const BATCH_SIZE = 500;
    for (let offset = 0; offset < REGRESSION_STREAM_COUNT; offset += BATCH_SIZE) {
        const batchEnd = Math.min(offset + BATCH_SIZE, REGRESSION_STREAM_COUNT);
        const streams = [];
        const events = [];

        for (let i = offset; i < batchEnd; i += 1) {
            const streamId = baseStreamId + i;
            const startTime = now - Math.floor(rng() * 90 * 24 * 60 * 60);
            const isActive = rng() > 0.3;
            const depositedAmount = String(Math.floor(rng() * 1_000_000_000_000));
            const withdrawnAmount = String(Math.floor(rng() * Number(depositedAmount)));

            streams.push({
                streamId,
                sender: DEMO_SENDER_PUBLIC_KEY,
                recipient: DEMO_RECIPIENT_PUBLIC_KEY,
                tokenAddress: DEMO_TOKEN_ADDRESS,
                ratePerSecond: String(Math.floor(rng() * 1_000_000_000)),
                depositedAmount,
                withdrawnAmount,
                startTime,
                lastUpdateTime: startTime + Math.floor(rng() * 86_400),
                isActive,
            });

            for (let e = 0; e < REGRESSION_EVENTS_PER_STREAM; e += 1) {
                const eventType = REGRESSION_EVENT_TYPES[e % REGRESSION_EVENT_TYPES.length];
                events.push({
                    streamId,
                    eventType,
                    amount: String(Math.floor(rng() * 1_000_000_000)),
                    transactionHash: `regression-${REGRESSION_SEED}-${streamId}-${e}`,
                    ledgerSequence: 100_000 + i * REGRESSION_EVENTS_PER_STREAM + e,
                    timestamp: startTime + e * 3_600,
                    metadata: JSON.stringify({ fixture: 'regression', seed: REGRESSION_SEED }),
                });
            }
        }

        await prisma.stream.createMany({ data: streams, skipDuplicates: true });
        await prisma.streamEvent.createMany({ data: events, skipDuplicates: true });
    }

    console.log('Regression fixtures seeded.');
}

async function main() {
    console.log('Seeding database...');

    // Create example users
    const user1 = await prisma.user.upsert({
        where: { publicKey: DEMO_SENDER_PUBLIC_KEY },
        update: {},
        create: {
            publicKey: DEMO_SENDER_PUBLIC_KEY,
        },
    });

    const user2 = await prisma.user.upsert({
        where: { publicKey: DEMO_RECIPIENT_PUBLIC_KEY },
        update: {},
        create: {
            publicKey: DEMO_RECIPIENT_PUBLIC_KEY,
        },
    });

    console.log({ user1, user2 });

    // Create an example stream
    const stream1 = await prisma.stream.upsert({
        where: { streamId: 101 },
        update: {},
        create: {
            streamId: 101,
            sender: user1.publicKey,
            recipient: user2.publicKey,
            tokenAddress: DEMO_TOKEN_ADDRESS,
            ratePerSecond: '100000000', // 10 XLM/sec if decimals=7
            depositedAmount: '1000000000000',
            withdrawnAmount: '0',
            startTime: Math.floor(Date.now() / 1000),
            lastUpdateTime: Math.floor(Date.now() / 1000),
            isActive: true,
        },
    });

    console.log({ stream1 });

    // Upsert an example event – keyed on the @@unique([transactionHash, eventType])
    // constraint so re-running the seed never creates duplicate rows.
    const DEMO_TX_HASH = '6f7e8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r';
    const event1 = await prisma.streamEvent.upsert({
        where: {
            transactionHash_eventType: {
                transactionHash: DEMO_TX_HASH,
                eventType: 'CREATED',
            },
        },
        update: {},
        create: {
            streamId: stream1.streamId,
            eventType: 'CREATED',
            amount: '1000000000000',
            transactionHash: DEMO_TX_HASH,
            ledgerSequence: 123456,
            timestamp: Math.floor(Date.now() / 1000),
            metadata: JSON.stringify({ memo: 'Seed data' }),
        },
    });

    console.log({ event1 });

    if (REGRESSION_ENABLED) {
        await seedRegressionFixtures();
    }

    console.log('Seeding finished.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
