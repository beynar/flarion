# P0 spike: FTS5 in Durable Object SQLite

Test: `tests/workers/fts5.test.ts` (real workerd, SQLite-backed Durable Object). Result: **everything the plan's Search section needs works.**

## What works
- `CREATE VIRTUAL TABLE search USING fts5(page_num UNINDEXED, field, text, tokenize = 'porter unicode61')` is accepted as written (note the spaces around `=` are fine; the tokenizer argument is one quoted string holding both names).
- `MATCH` with the porter stemmer: `plan` finds "Planning"/"planned"; `tomatoes` finds "tomato". unicode61 folds case and strips diacritics (`resume zoe` finds "Résumé of Zoë").
- Prefix queries (`quart*`, `tom*`) work and combine with `AND field = 'title'` for title-only quick find. Phrase (`"launch dates"`), `NOT`, and column filters (`text:garden`) work. `UNINDEXED` columns are not matchable.
- `bm25()`: negative, lower is better. Per-column weights work (`bm25(t, 0.0, 10.0, 1.0)`, one weight per column in declaration order, `UNINDEXED` columns take a placeholder).
- `snippet(search, 2, '<mark>', '</mark>', '…', N)` and `highlight()` work; with porter the highlighted tokens are the original word forms, not the stems.
- Maintenance: `DELETE` by `page_num` (a scan: the column is unindexed), `UPDATE`, `INSERT INTO search(search) VALUES ('optimize' | 'integrity-check')`. Shadow tables are `search_config/_content/_data/_docsize/_idx`.
- The `trigram` tokenizer is also compiled in (substring quick find, if wanted later).

## Findings that shape the design
1. **Title boost with the plan's schema (one row per field).** `field` is a row value, not a column, so FTS5 column weights cannot boost titles. Multiply the rank instead:
   `bm25(search, 0.0, 0.0, 1.0) * CASE field WHEN 'title' THEN 5.0 ELSE 1.0 END`. The test shows the multiplier decides the order (factor 5 keeps the title hit first, factor 0.1 flips it). With the 5x factor the sample query "planning" gives title -6.38 vs body -1.14.
   Alternative: one row per page with `title` and `body` columns and `bm25(page_search, 0.0, 10.0, 1.0)`. That is cheaper to rank and to aggregate per page, but body chunks and per-property text then need their own columns or a second table. Recommendation: keep the plan's `search(page_num, field, text)` for P3 (properties and body chunks are open-ended), boost by `field`.
2. **`bm25()` and `snippet()` only work in the SELECT list of the query that holds the `MATCH`.** Wrapping them in a subquery that an outer `GROUP BY` flattens fails with `unable to use function bm25 in the requested context`. To rank per page (best row per page), use `WITH hits AS MATERIALIZED (SELECT page_num, <boosted bm25> AS rank FROM search WHERE search MATCH ?) SELECT page_num, MIN(rank) FROM hits GROUP BY page_num ORDER BY rank`. Tested.
3. **Ranks are tiny-corpus numbers**: bm25 depends on corpus statistics, so compare ranks within one query only.
4. **Escape user input.** MATCH parses a query language; a raw user string with `"`, `-`, `:` or `*` can throw. Quote each token (`"word"`, doubling inner quotes) and append `*` to the last one for quick find.
5. **Visibility (PLAN: fetch 3x, filter, then rank)** works on top of this: take the MATCH result with a `LIMIT`, intersect `page_num` with the visibility set, then rank.
6. Re-indexing a page is `DELETE ... WHERE page_num = ?` then inserts inside the same `transactionSync`; at workspace scale the unindexed delete scan is acceptable. If it shows up in profiles, store `rowid`s per page in a side table.
