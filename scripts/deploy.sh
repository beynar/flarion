#!/usr/bin/env bash
# Deploy Flarion to one Wrangler environment. Same steps CI runs (.github/workflows/ci.yml):
#   build -> secrets check -> D1 migrations -> Tail Worker -> main Worker
#
#   scripts/deploy.sh staging                # wrangler deploy --env staging (full, immediate)
#   scripts/deploy.sh production             # gradual: versions upload, then versions deploy 10% -> 50% -> 100%
#   scripts/deploy.sh production --full      # plain `wrangler deploy` (first deploy, Durable Object migrations)
#
# Options: --full  --skip-build  --skip-checks  --skip-tail  --dry-run  --yes
# Env:     CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (or `wrangler login` locally)
#          ROLLOUT_STEPS="10 50"   percentages before the final 100% (production)
#          ROLLOUT_WAIT=120        seconds to soak at each step
#          SKIP_TAIL=1             do not deploy the Tail Worker (same as --skip-tail)
#          HEALTH_URL=...          override the /healthz base URL (default: APP_ORIGIN of the environment)
#          FULL_DEPLOY=1           same as --full
#          SKIP_SECRETS_CHECK=1    bootstrap only: the Worker does not exist yet, so it has no secrets
#
# The main Worker names the Tail Worker in `tail_consumers` (wrangler.jsonc): a deploy fails when that service does not exist
# yet, so workers/tail is deployed first, in every mode (it has no state and is cheap). The secrets the app reads without
# requiring them (optional: the Worker degrades without them) are listed by the secrets check and in docs/ops/secrets.md.
#
# Gradual deployments cannot carry Durable Object migrations, a new Worker or trigger/route changes:
# use --full for the first deploy of an environment and whenever `migrations` in wrangler.jsonc gains
# a tag. A full deploy is also chosen automatically when the Worker has no deployment yet.
set -euo pipefail

cd "$(dirname "$0")/.."

ENVIRONMENT="${1:-}"
shift || true
FULL="${FULL_DEPLOY:-0}"; SKIP_BUILD=0; SKIP_CHECKS="${SKIP_SECRETS_CHECK:-0}"; SKIP_TAIL="${SKIP_TAIL:-0}"; DRY=0; YES=0
for arg in "$@"; do
	case "$arg" in
		--full) FULL=1 ;;
		--skip-build) SKIP_BUILD=1 ;;
		--skip-checks) SKIP_CHECKS=1 ;;
		--skip-tail) SKIP_TAIL=1 ;;
		--dry-run) DRY=1 ;;
		--yes|-y) YES=1 ;;
		*) echo "Unknown option: $arg" >&2; exit 2 ;;
	esac
done
case "$ENVIRONMENT" in
	staging|production) ;;
	*) echo "Usage: scripts/deploy.sh <staging|production> [--full] [--skip-build] [--skip-checks] [--skip-tail] [--dry-run] [--yes]" >&2; exit 2 ;;
esac

WRANGLER="pnpm exec wrangler"
REQUIRED_SECRETS=(BETTER_AUTH_SECRET ROOM_TOKEN_KEY API_TOKEN_PEPPER)
# Optional: the Worker runs without them and says what to set (docs/ops/secrets.md).
#   TURNSTILE_SECRET     sign-up bot check (off without it)
#   ADMIN_KEY            recovery routes /admin/* (404 without it), docs/ops/restore.md
#   LOAD_TEST_KEY        staging load test user minting (404 without it), docs/ops/load-test.md
#   ANALYTICS_API_TOKEN  SLO dashboard and alert cron read Analytics Engine (docs/ops/alerts.md)
#   ALERT_EMAIL          where the alert cron mails (secret or var)
#   ADMIN_EMAILS         narrows the SLO dashboard to these people (comma-separated emails; owners otherwise)
OPTIONAL_SECRETS=(TURNSTILE_SECRET ADMIN_KEY LOAD_TEST_KEY ANALYTICS_API_TOKEN ALERT_EMAIL ADMIN_EMAILS)
ROLLOUT_STEPS="${ROLLOUT_STEPS:-10 50}"
ROLLOUT_WAIT="${ROLLOUT_WAIT:-120}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

log() { printf '\n==> %s\n' "$*"; }
run() {
	printf '+ %s\n' "$*"
	if [ "$DRY" = 1 ]; then return 0; fi
	"$@"
}
# Read a value out of wrangler.jsonc (comments stripped): config_value 'env.production.vars.APP_ORIGIN'
config_value() {
	node -e '
		const fs = require("node:fs");
		const text = fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "");
		let v = JSON.parse(text);
		for (const k of process.argv[1].split(".")) v = v?.[k];
		process.stdout.write(v === undefined ? "" : String(v));
	' "$1"
}

# The names of the keys of an object in wrangler.jsonc, space separated: config_keys 'env.production.vars'
config_keys() {
	node -e '
		const fs = require("node:fs");
		const text = fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "");
		let v = JSON.parse(text);
		for (const k of process.argv[1].split(".")) v = v?.[k];
		process.stdout.write(v && typeof v === "object" ? Object.keys(v).join(" ") : "");
	' "$1"
}

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ "$DRY" = 0 ]; then
	echo "CLOUDFLARE_API_TOKEN is not set; relying on a local \`wrangler login\` session." >&2
fi

if [ "$ENVIRONMENT" = production ] && [ "$YES" = 0 ] && [ "$DRY" = 0 ] && [ -z "${CI:-}" ]; then
	read -r -p "Deploy to PRODUCTION? [y/N] " answer
	[ "$answer" = y ] || { echo "Aborted."; exit 1; }
fi

# 1. Build -------------------------------------------------------------------------------------------
if [ "$SKIP_BUILD" = 0 ]; then
	log "Build"
	run pnpm build
fi

# 2. Secrets check -----------------------------------------------------------------------------------
if [ "$SKIP_CHECKS" = 0 ] && [ "$DRY" = 0 ]; then
	log "Secrets check ($ENVIRONMENT)"
	if ! $WRANGLER secret list --env "$ENVIRONMENT" --format json > "$WORK_DIR/secrets.json" 2> "$WORK_DIR/secrets.err"; then
		cat "$WORK_DIR/secrets.err" >&2
		echo "Could not list secrets (does the Worker exist yet?). For the very first deploy set SKIP_SECRETS_CHECK=1." >&2
		exit 1
	fi
	# ALERT_EMAIL and ADMIN_EMAILS may be plain vars in wrangler.jsonc instead of secrets: either counts.
	vars=$(config_keys "env.$ENVIRONMENT.vars")
	missing=$(node -e '
		const have = new Set(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).map((s) => s.name));
		for (const n of process.argv[4].split(" ").filter(Boolean)) have.add(n);
		const [required, optional] = [process.argv[2].split(" "), process.argv[3].split(" ")];
		for (const n of optional) if (!have.has(n)) console.error(`warning: optional secret ${n} is not set`);
		process.stdout.write(required.filter((n) => !have.has(n)).join(" "));
	' "$WORK_DIR/secrets.json" "${REQUIRED_SECRETS[*]}" "${OPTIONAL_SECRETS[*]}" "$vars")
	if [ -n "$missing" ]; then
		for name in $missing; do echo "Missing secret: $name  (pnpm exec wrangler secret put $name --env $ENVIRONMENT)" >&2; done
		exit 1
	fi
else
	log "Secrets check skipped"
fi

# 3. D1 migrations -----------------------------------------------------------------------------------
# Additive only: the previous version keeps working against the new schema while a rollout is in flight.
log "D1 migrations ($ENVIRONMENT)"
run $WRANGLER d1 migrations apply DB --remote --env "$ENVIRONMENT"

# 4. Deploy ------------------------------------------------------------------------------------------
health_check() {
	local base="${HEALTH_URL:-$(config_value "env.$ENVIRONMENT.vars.APP_ORIGIN")}"
	local ok=0
	# During a split rollout requests land on either version, so sample several times.
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		if curl -fsS --max-time 10 "$base/healthz" > /dev/null; then ok=$((ok + 1)); fi
	done
	echo "health: $ok/10 ok at $base/healthz"
	[ "$ok" -ge 10 ]
}

current_version() {
	{ $WRANGLER deployments status --env "$ENVIRONMENT" --json 2> /dev/null || true; } | node -e '
		let input = "";
		process.stdin.on("data", (c) => (input += c)).on("end", () => {
			try {
				const versions = JSON.parse(input).versions ?? [];
				versions.sort((a, b) => b.percentage - a.percentage);
				process.stdout.write(versions[0]?.version_id ?? "");
			} catch {}
		});
	'
}

# The Tail Worker first: `tail_consumers` of the main Worker points at it.
deploy_tail() {
	if [ "$SKIP_TAIL" = 1 ]; then log "Tail Worker skipped"; return; fi
	log "Tail Worker ($ENVIRONMENT)"
	run $WRANGLER deploy -c workers/tail/wrangler.jsonc --env "$ENVIRONMENT" --message "${DEPLOY_MESSAGE:-tail $(git rev-parse --short HEAD 2> /dev/null || echo local)}"
}

full_deploy() {
	log "Full deploy ($ENVIRONMENT)"
	run $WRANGLER deploy --env "$ENVIRONMENT" --message "${DEPLOY_MESSAGE:-deploy $(git rev-parse --short HEAD 2> /dev/null || echo local)}"
}

gradual_deploy() {
	local tag message previous new output="$WORK_DIR/upload.ndjson"
	tag="$(git rev-parse --short HEAD 2> /dev/null || echo local)"
	message="${DEPLOY_MESSAGE:-deploy $tag}"
	previous="$(current_version)"
	if [ -z "$previous" ] && [ "$DRY" = 0 ]; then
		echo "No current deployment for $ENVIRONMENT: falling back to a full deploy."
		full_deploy
		return
	fi

	log "Upload version ($ENVIRONMENT, tag $tag)"
	if [ "$DRY" = 1 ]; then
		run $WRANGLER versions upload --env "$ENVIRONMENT" --tag "$tag" --message "$message"
		new="<new-version-id>"; previous="<previous-version-id>"
	else
		WRANGLER_OUTPUT_FILE_PATH="$output" $WRANGLER versions upload --env "$ENVIRONMENT" --tag "$tag" --message "$message"
		new=$(node -e '
			const lines = require("node:fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
			const entry = lines.map((l) => JSON.parse(l)).reverse().find((e) => e.type === "version-upload");
			process.stdout.write(entry?.version_id ?? "");
		' "$output")
		[ -n "$new" ] || { echo "Could not read the uploaded version id." >&2; exit 1; }
	fi

	for pct in $ROLLOUT_STEPS; do
		log "Rollout ${pct}% ($ENVIRONMENT)"
		run $WRANGLER versions deploy "$new@$pct" "$previous@$((100 - pct))" --env "$ENVIRONMENT" --yes --message "$message ($pct%)"
		if [ "$DRY" = 0 ]; then
			sleep "$ROLLOUT_WAIT"
			if ! health_check; then
				echo "Health check failed at ${pct}%: rolling back to $previous" >&2
				$WRANGLER versions deploy "$previous@100" --env "$ENVIRONMENT" --yes --message "rollback of $tag"
				exit 1
			fi
		fi
	done

	log "Rollout 100% ($ENVIRONMENT)"
	run $WRANGLER versions deploy "$new@100" --env "$ENVIRONMENT" --yes --message "$message (100%)"
	# versions deploy leaves routes and cron triggers alone: sync them (idempotent).
	run $WRANGLER triggers deploy --env "$ENVIRONMENT"
	if [ "$DRY" = 0 ]; then health_check; fi
}

deploy_tail

if [ "$ENVIRONMENT" = staging ] || [ "$FULL" = 1 ]; then
	full_deploy
else
	gradual_deploy
fi

log "Done: $ENVIRONMENT"
