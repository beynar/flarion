/**
 * Subscriptions live in a table, not in memory or in the socket attachment (2,048 byte cap), so they
 * survive hibernation: after the object wakes, a pushed event only needs `(socketId, requestId)`.
 * P1 (Sync core) replaces `topic` with its compiled view subscriptions; the shape stays.
 */
export interface SubscriptionRow {
	socketId: string;
	requestId: string;
	topic: string;
}

export class SubscriptionStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		sql.exec(`CREATE TABLE IF NOT EXISTS socket_subscription (
			socket_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			topic TEXT NOT NULL,
			PRIMARY KEY (socket_id, request_id)
		)`);
		sql.exec('CREATE INDEX IF NOT EXISTS socket_subscription_topic ON socket_subscription (topic)');
	}

	add(socketId: string, requestId: string, topic: string): void {
		this.#sql.exec(
			'INSERT OR REPLACE INTO socket_subscription (socket_id, request_id, topic) VALUES (?, ?, ?)',
			socketId,
			requestId,
			topic
		);
	}

	forTopic(topic: string): SubscriptionRow[] {
		return this.#sql
			.exec<{ socket_id: string; request_id: string; topic: string }>(
				'SELECT socket_id, request_id, topic FROM socket_subscription WHERE topic = ?',
				topic
			)
			.toArray()
			.map((r) => ({ socketId: r.socket_id, requestId: r.request_id, topic: r.topic }));
	}

	forSocket(socketId: string): SubscriptionRow[] {
		return this.#sql
			.exec<{ socket_id: string; request_id: string; topic: string }>(
				'SELECT socket_id, request_id, topic FROM socket_subscription WHERE socket_id = ?',
				socketId
			)
			.toArray()
			.map((r) => ({ socketId: r.socket_id, requestId: r.request_id, topic: r.topic }));
	}

	remove(socketId: string, requestId: string): void {
		this.#sql.exec(
			'DELETE FROM socket_subscription WHERE socket_id = ? AND request_id = ?',
			socketId,
			requestId
		);
	}

	removeSocket(socketId: string): void {
		this.#sql.exec('DELETE FROM socket_subscription WHERE socket_id = ?', socketId);
	}
}
