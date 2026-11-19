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

// Optional large-dataset seeding for validating database maintenance and bloat
// monitoring metrics (issue #289). Disabled by default so normal seeds stay
// fast; enable with SEED_LARGE_DATASET=true. This only inserts rows — it never
// runs VACUUM, REINDEX, or any destructive maintenance automatically.
const SEED_LARGE_DATASET = process.env.SEED_LARGE_DATASET === 'true';
const LARGE_DATASET_EVENT_COUNT = Number.parseInt(
    process.env.SEED_LARGE_DATASET_EVENT_COUNT ?? '5000',
    10,
);

async function seedLargeDataset(streamId: number): Promise<void> {
    const count = Number.isFinite(LARGE_DATASET_EVENT_COUNT) && LARGE_DATASET_EVENT_COUNT > 0
        ? LARGE_DATASET_EVENT_COUNT
        : 5000;

    console.log(`Seeding large dataset: ${count} stream events...`);

    const now = Math.floor(Date.now() / 1000);
    const batchSize = 500;

    for (let offset = 0; offset < count; offset += batchSize) {
        const batch = Array.from(
            { length: Math.min(batchSize, count - offset) },
            (_, i) => {
                const index = offset + i;
                return {
                    streamId,
                    eventType: 'WITHDRAWN',
                    amount: '1000000',
                    transactionHash: `seed-large-${index.toString(16).padStart(56, '0')}`,
                    ledgerSequence: 200000 + index,
                    timestamp: now - index,
                    metadata: JSON.stringify({ memo: 'Large dataset seed', index }),
                };
            },
        );

        await prisma.streamEvent.createMany({
            data: batch,
            skipDuplicates: true,
        });
    }

    console.log(`Large dataset seeding finished (${count} events).`);
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

    if (SEED_LARGE_DATASET) {
        await seedLargeDataset(stream1.streamId);
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
