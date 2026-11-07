/**
 * viborm's driver contracts (vendored in ./viborm) registered against the Durable Object SQLite driver:
 * nested writes, junctions, upserts, bulk writes, JSON, raw array transactions.
 */
import { durableObjectDriver } from './harness/do-vitest';
import { nestedWriteContract } from './viborm/behaviors/nested-write-behavior';
import { nestedWriteAdvancedContract } from './viborm/behaviors/nested-write-advanced-behavior';
import { nestedWriteJsonEnvelopeContract } from './viborm/behaviors/nested-write-json-envelope-behavior';
import { compoundKeyContract } from './viborm/behaviors/compound-key-behavior';
import { compoundJunctionContract } from './viborm/behaviors/compound-junction-behavior';
import { polymorphicMemberJunctionContract } from './viborm/behaviors/polymorphic-member-junction-behavior';
import { manyToManyContract } from './viborm/behaviors/many-to-many-behavior';
import { prismaParityContract } from './viborm/behaviors/prisma-parity-behavior';
import { optionalRelationParityContract } from './viborm/behaviors/optional-relation-parity-behavior';
import { upsertAtomicityContract } from './viborm/behaviors/upsert-atomicity-behavior';
import { relationFilterMutationContract } from './viborm/behaviors/relation-filter-mutation-behavior';
import { orderingArrayCreateContract } from './viborm/behaviors/ordering-array-create-behavior';
import { implicitReturningContract } from './viborm/behaviors/implicit-returning-behavior';
import { createManyReturnFoldContract } from './viborm/behaviors/create-many-return-fold-behavior';
import { bulkWriteLimitContract } from './viborm/behaviors/bulk-write-limit-behavior';
import { listJsonFilterContract } from './viborm/behaviors/list-json-filter-behavior';
import { jsonNullSentinelContract } from './viborm/behaviors/json-null-sentinel-behavior';
import { rawArrayTransactionContract } from './viborm/behaviors/raw-array-transaction-behavior';

const driverName = 'Durable Object SQLite';
const createDriver = () => durableObjectDriver();

nestedWriteContract.register({ driverName, createDriver });
nestedWriteAdvancedContract.register({ driverName, createDriver });
nestedWriteJsonEnvelopeContract.register({ driverName, createDriver });
compoundKeyContract.register({ driverName, createDriver });
compoundJunctionContract.register({ driverName, createDriver });
polymorphicMemberJunctionContract.register({ driverName, createDriver });
manyToManyContract.register({ driverName, createDriver });
prismaParityContract.register({ driverName, createDriver });
optionalRelationParityContract.register({ driverName, createDriver });
upsertAtomicityContract.register({ driverName, createDriver });
relationFilterMutationContract.register({ driverName, createDriver });
orderingArrayCreateContract.register({ driverName, createDriver });
implicitReturningContract.register({ driverName, createDriver });
createManyReturnFoldContract.register({ driverName, createDriver });
bulkWriteLimitContract.register({ driverName, createDriver });
listJsonFilterContract.register({ driverName, createDriver });
jsonNullSentinelContract.register({ driverName, createDriver });
rawArrayTransactionContract.register({ name: driverName, createDriver });
