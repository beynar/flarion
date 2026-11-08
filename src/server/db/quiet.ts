/**
 * Marker for raw writes whose caller does not read the affected-row count. The Durable Object driver asks SQLite for `changes()` and
 * `last_insert_rowid()` after every write (one more statement each, about a quarter of the statements of a view-less commit); a statement
 * that starts with this marker skips that read and reports `0`. The marker is stripped before the statement reaches SQLite.
 */
export const QUIET_WRITE = '/*quiet*/';
export const quiet = (sql: string): string => QUIET_WRITE + sql;
