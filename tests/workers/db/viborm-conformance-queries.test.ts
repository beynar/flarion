/**
 * viborm's driver contracts (vendored in ./viborm) registered against the Durable Object SQLite driver:
 * reads, pagination, windows, index DDL. Mirrors viborm's own `sqlite3` provider registrations.
 */
import { durableObjectDriver } from './harness/do-vitest';
import { fkIndexContract, fkIndexPlanContract, fkIndexUpgradeContract } from './viborm/behaviors/fk-index-behavior';
import { mappedIndexContract, partialIndexContract, partialIndexCoverageContract } from './viborm/behaviors/index-ddl-behavior';
import { forwardFkOrderingContract } from './viborm/behaviors/forward-fk-ordering-behavior';
import { countAggregateWindowContract } from './viborm/behaviors/count-aggregate-window-behavior';
import { distinctSkipWindowContract } from './viborm/behaviors/distinct-skip-window-behavior';
import { cursorPaginationContract } from './viborm/behaviors/cursor-pagination-behavior';
import { nestedPaginationContract } from './viborm/behaviors/nested-pagination-behavior';
import { nestedOrderByContract } from './viborm/behaviors/nested-orderby-behavior';
import { readPathRegressionContract } from './viborm/behaviors/read-path-regression-behavior';
import { clientRawContract } from './viborm/behaviors/client-raw-behavior';
import { likeEscapeContract } from './viborm/behaviors/like-escape-behavior';
import { blobFilterContract } from './viborm/behaviors/blob-filter-behavior';

const driverName = 'Durable Object SQLite';
const createDriver = () => durableObjectDriver();

fkIndexContract.register({ driverName, createDriver });
mappedIndexContract.register({ driverName, createDriver });
partialIndexContract.register({ driverName, createDriver });
partialIndexCoverageContract.register({ driverName, createDriver });
fkIndexUpgradeContract.register({ driverName, createDriver });
fkIndexPlanContract.register({ driverName, createDriver });
forwardFkOrderingContract.register({ driverName, createDriver, fkNamesRoundTrip: false });
countAggregateWindowContract.register({ driverName, createDriver });
distinctSkipWindowContract.register({ driverName, createDriver });
cursorPaginationContract.register({ driverName, createDriver });
nestedPaginationContract.register({ driverName, createDriver });
nestedOrderByContract.register({ driverName, createDriver });
readPathRegressionContract.register({ driverName, createDriver });
clientRawContract.register({ driverName, createDriver });
likeEscapeContract.register({ driverName, createDriver });
blobFilterContract.register({ driverName, createDriver });
