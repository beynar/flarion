/**
 * Local development only: applies `migrations/d1/*.sql` to the dev D1 database the first time a request
 * needs it, so `pnpm dev` works without a manual `wrangler d1 migrations apply --local`. It records files
 * in wrangler's own `d1_migrations` table, so the two never apply the same file twice. Staging and
 * production are migrated by `wrangler d1 migrations apply` (see scripts/deploy.sh) and never run this.
 */
const migrationFiles = import.meta.glob('/migrations/d1/*.sql', { query: '?raw', import: 'default' }) as Record<
	string,
	() => Promise<string>
>;

let ready: Promise<void> | undefined;

/** Splits a migration file into statements (the generated SQL never has a semicolon inside a string). */
export function splitStatements(sql: string): string[] {
	return sql
		.replace(/^\s*--.*$/gm, '')
		.split(';')
		.map((statement) => statement.trim())
		.filter(Boolean);
}

export function ensureDevSchema(env: Pick<Env, 'DB'> & { ENVIRONMENT?: string }): Promise<void> {
	if (env.ENVIRONMENT !== 'development') return Promise.resolve();
	ready ??= apply(env.DB).catch((error) => {
		ready = undefined;
		throw error;
	});
	return ready;
}

async function apply(db: D1Database): Promise<void> {
	await db
		.prepare(
			'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)'
		)
		.run();
	const applied = new Set(
		((await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results ?? []).map((row) => row.name)
	);
	const names = Object.keys(migrationFiles).sort();
	for (const path of names) {
		const name = path.split('/').pop()!;
		if (applied.has(name)) continue;
		const sql = await migrationFiles[path]!();
		// One statement at a time: dev D1 goes through a platform proxy where `batch` is less forgiving.
		for (const statement of splitStatements(sql)) await db.prepare(statement).run();
		await db.prepare('INSERT INTO d1_migrations (name) VALUES (?1)').bind(name).run();
		console.log(`[dev] applied D1 migration ${name}`);
	}
}
