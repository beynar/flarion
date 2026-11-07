/**
 * FTS5 smoke test for the Workspace DO's search table (docs/PLAN.md "Search"). Findings are recorded
 * in docs/spikes/p0-fts5.md.
 */
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { testEnv } from './helpers';

type Row = Record<string, string | number | null>;

/** Run `fn` against a fresh SQLite Durable Object with the search table, seeded with a few pages. */
async function withIndex<T>(name: string, fn: (sql: SqlStorage) => T): Promise<T> {
	const stub = testEnv.TEST_SQL.getByName(name);
	return runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => {
		const sql = state.storage.sql;
		sql.exec(`CREATE VIRTUAL TABLE search USING fts5(
			page_num UNINDEXED, field, text,
			tokenize = 'porter unicode61'
		)`);
		const rows: Array<[number, string, string]> = [
			[1, 'title', 'Quarterly planning'],
			[1, 'body', 'We reviewed the roadmap and agreed on the launch dates for every team.'],
			[2, 'title', 'Meeting notes'],
			[2, 'body', 'Planning the quarterly offsite: venues, budgets and travel. Planning is hard.'],
			[3, 'title', 'Garden journal'],
			[3, 'body', 'Tomatoes ripened early. Planted basil next to the tomato rows; watering twice a day.'],
			[4, 'title', 'Résumé of Zoë'],
			[4, 'body', 'Experienced engineer: databases, search and realtime systems.']
		];
		for (const [num, field, text] of rows) sql.exec('INSERT INTO search (page_num, field, text) VALUES (?, ?, ?)', num, field, text);
		return fn(sql);
	});
}

const all = (sql: SqlStorage, query: string, ...bindings: unknown[]) => sql.exec<Row>(query, ...bindings).toArray();
const pages = (rows: Row[]) => rows.map((row) => row.page_num);

describe('FTS5 in Durable Object SQLite', () => {
	it('creates the table with the porter unicode61 tokenizer and answers MATCH', async () => {
		await withIndex('fts-match', (sql) => {
			expect(pages(all(sql, "SELECT page_num FROM search WHERE search MATCH 'roadmap'"))).toEqual([1]);
			expect(new Set(pages(all(sql, "SELECT page_num FROM search WHERE search MATCH 'plan'")))).toEqual(new Set([1, 2]));
			expect(new Set(pages(all(sql, "SELECT page_num FROM search WHERE search MATCH 'tomatoes'")))).toEqual(new Set([3]));
			// unicode61 folds case and strips diacritics: "resume zoe" matches "Résumé of Zoë".
			expect(pages(all(sql, "SELECT page_num FROM search WHERE search MATCH 'resume zoe'"))).toEqual([4]);
			expect(pages(all(sql, `SELECT page_num FROM search WHERE search MATCH '"launch dates"'`))).toEqual([1]);
			expect(new Set(pages(all(sql, "SELECT page_num FROM search WHERE search MATCH 'quarterly NOT offsite'")))).toEqual(new Set([1]));
			expect(all(sql, "SELECT page_num FROM search WHERE search MATCH 'nothing'")).toEqual([]);
		});
	});

	it('restricts a match to a column and supports prefix queries', async () => {
		await withIndex('fts-prefix', (sql) => {
			expect(pages(all(sql, "SELECT page_num FROM search WHERE search MATCH 'text:garden'"))).toEqual([3]);
			expect(new Set(pages(all(sql, "SELECT page_num FROM search WHERE search MATCH 'quart*'")))).toEqual(new Set([1, 2]));
			expect(new Set(pages(all(sql, "SELECT page_num FROM search WHERE search MATCH 'tom*'")))).toEqual(new Set([3]));
			// Title prefix only: filter on the `field` column value.
			expect(pages(all(sql, "SELECT page_num FROM search WHERE search MATCH 'quart*' AND field = 'title'"))).toEqual([1]);
		});
	});

	it('ranks with bm25 and a title boost applied per field value', async () => {
		await withIndex('fts-bm25', (sql) => {
			// bm25() is negative: lower is better.
			const plain = all(
				sql,
				"SELECT page_num, field, bm25(search) AS rank FROM search WHERE search MATCH 'planning' ORDER BY rank"
			);
			expect(plain.length).toBe(2); // page 1's title and page 2's body
			for (const row of plain) expect(row.rank as number).toBeLessThan(0);

			// Weights are per column and `field` is a column value here, so the boost is a multiplier on
			// the rank of rows whose field is "title".
			const boosted = all(
				sql,
				`SELECT page_num, field,
					bm25(search, 0.0, 0.0, 1.0) * CASE field WHEN 'title' THEN 5.0 ELSE 1.0 END AS rank
				 FROM search WHERE search MATCH 'planning' ORDER BY rank`
			);
			expect(boosted[0]).toMatchObject({ page_num: 1, field: 'title' });
			expect(pages(boosted).slice(0, 2)).toEqual([1, 2]);

			// The multiplier is what decides: a title factor below 1 demotes titles and flips the order.
			const demoted = all(
				sql,
				`SELECT page_num FROM search WHERE search MATCH 'planning'
				 ORDER BY bm25(search, 0.0, 0.0, 1.0) * CASE field WHEN 'title' THEN 0.1 ELSE 1.0 END`
			);
			expect(pages(demoted)).toEqual([2, 1]);

			// Best boosted rank per page. bm25() is an auxiliary function: it only works in the SELECT list
			// of the query that holds the MATCH. Wrapped in a plain subquery that an outer GROUP BY flattens,
			// it fails ("unable to use function bm25 in the requested context"), so the hit list is a
			// MATERIALIZED CTE and the aggregation runs over its already computed ranks.
			expect(() =>
				all(
					sql,
					`SELECT page_num, MIN(rank) AS rank FROM (
						SELECT page_num, bm25(search, 0.0, 0.0, 1.0) AS rank FROM search WHERE search MATCH 'planning'
					) GROUP BY page_num`
				)
			).toThrow(/bm25/);
			const perPage = all(
				sql,
				`WITH hits AS MATERIALIZED (
					SELECT page_num, bm25(search, 0.0, 0.0, 1.0) * CASE field WHEN 'title' THEN 5.0 ELSE 1.0 END AS rank
					FROM search WHERE search MATCH 'planning'
				) SELECT page_num, MIN(rank) AS rank FROM hits GROUP BY page_num ORDER BY rank`
			);
			expect(pages(perPage)).toEqual([1, 2]);
		});
	});

	it('ranks with per-column bm25 weights when title and body are separate columns', async () => {
		const stub = testEnv.TEST_SQL.getByName('fts-columns');
		await runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => {
			const sql = state.storage.sql;
			sql.exec("CREATE VIRTUAL TABLE page_search USING fts5(page_num UNINDEXED, title, body, tokenize = 'porter unicode61')");
			sql.exec('INSERT INTO page_search VALUES (1, ?, ?)', 'Budget', 'Yearly numbers and forecasts');
			sql.exec('INSERT INTO page_search VALUES (2, ?, ?)', 'Notes', 'budget budget budget budget budget in the body only');
			const rank = (weights: string) =>
				pages(all(sql, `SELECT page_num FROM page_search WHERE page_search MATCH 'budget' ORDER BY bm25(page_search, ${weights})`));
			expect(rank('0.0, 1.0, 1.0')[0]).toBe(2); // equal weights: the repetitive body wins
			expect(rank('0.0, 10.0, 1.0')[0]).toBe(1); // title weight 10: the title hit wins
		});
	});

	it('produces highlighted snippets with snippet() and highlight()', async () => {
		await withIndex('fts-snippet', (sql) => {
			const [row] = all(
				sql,
				`SELECT page_num, snippet(search, 2, '<mark>', '</mark>', '…', 30) AS snip
				 FROM search WHERE search MATCH 'tomatoes' AND field = 'body'`
			);
			expect(row.page_num).toBe(3);
			// Porter: the stem match highlights the original word forms.
			expect(row.snip).toContain('<mark>Tomatoes</mark>');
			expect(row.snip).toContain('<mark>tomato</mark>');

			const [hl] = all(
				sql,
				`SELECT highlight(search, 2, '[', ']') AS hl FROM search WHERE search MATCH 'roadmap' AND field = 'body'`
			);
			expect(hl.hl).toContain('[roadmap]');
		});
	});

	it('re-indexes a page by delete and insert, and runs the maintenance commands', async () => {
		await withIndex('fts-maintenance', (sql) => {
			sql.exec('DELETE FROM search WHERE page_num = ?', 3);
			expect(all(sql, "SELECT page_num FROM search WHERE search MATCH 'tomatoes'")).toEqual([]);
			sql.exec("INSERT INTO search (page_num, field, text) VALUES (3, 'title', 'Garden journal v2')");
			expect(pages(all(sql, "SELECT page_num FROM search WHERE search MATCH 'v2'"))).toEqual([3]);
			sql.exec("UPDATE search SET text = 'Renamed to orchard' WHERE page_num = 3 AND field = 'title'");
			expect(pages(all(sql, "SELECT page_num FROM search WHERE search MATCH 'orchard'"))).toEqual([3]);
			sql.exec("INSERT INTO search(search) VALUES ('optimize')");
			sql.exec("INSERT INTO search(search) VALUES ('integrity-check')");
			const shadow = all(sql, "SELECT name FROM sqlite_master WHERE name LIKE 'search\\_%' ESCAPE '\\' ORDER BY name").map((row) => row.name);
			expect(shadow).toEqual(['search_config', 'search_content', 'search_data', 'search_docsize', 'search_idx']);
		});
	});

	it('also offers the trigram tokenizer for substring quick-find', async () => {
		await withIndex('fts-trigram', (sql) => {
			sql.exec("CREATE VIRTUAL TABLE tri USING fts5(t, tokenize = 'trigram')");
			sql.exec("INSERT INTO tri VALUES ('Quarterly planning')");
			expect(all(sql, "SELECT t FROM tri WHERE tri MATCH 'terl'")).toHaveLength(1);
		});
	});
});
