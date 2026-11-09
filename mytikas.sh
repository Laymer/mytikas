#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "$ROOT"
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: ./mytikas.sh [--demo] COMMAND [arguments...]
  help                    Show this help (Docker not required)
  doctor                  Check Bash 4+, Node 24, Compose 2.24.4+, daemon/config
  init                    Create missing private secrets; preserve existing files
  build                   Build images
  up                      Initialize, build, start and wait for readiness (180s)
  start | stop | restart   Operate existing containers; use up to apply changes
  down                    Remove containers/networks; preserve database volumes
  status | health          Show container state / require app readiness
  logs [--follow] [services...]   Last 100 lines, optionally follow
  shell [service]          Open sh in app (or specified running service)
  db [psql arguments...]   PostgreSQL client (supports redirected input)
  migrate                 Run migrations in a one-off backend container
  admin                   Interactive first-admin setup
  backup [path]           Private custom-format pg_dump; refuses overwrites
  demo up | seed | accounts | summary | down
  demo armory <email> <member|outsider|missing|unavailable>
  demo check <email>       Check approved application; normal cooldown applies
  demo reset --yes         Recreate ONLY the demo database and reseed

Normal: localhost:8080, project mytikas, .env
Demo: localhost:8081, project mytikas-demo, .env.demo
Only demo accounts prints the persistent shared demo password.
HELP
}
(( BASH_VERSINFO[0] >= 4 )) || fail 'Bash 4+ required'
MODE=normal
if [[ ${1:-} == --demo ]]; then MODE=demo; shift; fi
COMMAND=${1:-help}
[[ $# == 0 ]] || shift
if [[ $COMMAND == demo ]]; then MODE=demo; COMMAND=${1:-help}; [[ $# == 0 ]] || shift; fi
if [[ $COMMAND == help ]]; then usage; exit 0; fi
case "$COMMAND" in
  doctor|init|build|up|start|stop|restart|down|status|health|logs|shell|db|migrate|admin|backup) ;;
  seed|accounts|summary|armory|check|reset) [[ $MODE == demo ]] || fail 'This command requires demo' ;;
  *) fail "Unknown command: $COMMAND (see help)" ;;
esac
case "$COMMAND" in
  logs|db|backup|shell|armory|check|reset) ;;
  *) [[ $# == 0 ]] || fail "Unexpected arguments for $COMMAND" ;;
esac
ENVFILE="$ROOT/.env"; PROJECT=mytikas
FILES=(-f "$ROOT/compose.yaml")
if [[ $MODE == demo ]]; then ENVFILE="$ROOT/.env.demo"; PROJECT=mytikas-demo; FILES+=(-f "$ROOT/compose.demo.yaml"); fi
# Environment files, rather than ambient shell variables, select credentials and origins.
unset POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD DATABASE_URL SESSION_SECRET APP_ORIGIN PORT DISCORD_WEBHOOK_URL DEMO_PASSWORD MYTIKAS_DEMO COMPOSE_FILE COMPOSE_PROJECT_NAME
DC=(docker compose --project-name "$PROJECT" --env-file "$ENVFILE" "${FILES[@]}")
node_check() { command -v node >/dev/null || fail 'Node.js 24 required'; [[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || fail 'Node.js 24 required'; }
initialize() { node_check; node scripts/init-env.mjs "$MODE"; }
docker_check() {
  command -v docker >/dev/null || fail 'Docker required'
  local version major minor patch
  version=$(docker compose version --short) || fail 'Docker Compose required'
  version=${version#v}; IFS=. read -r major minor patch <<< "$version"
  [[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] || fail 'Unrecognized Compose version'
  (( major > 2 || (major == 2 && (minor > 24 || (minor == 24 && ${patch%%-*} >= 4))) )) || fail 'Compose 2.24.4+ required'
  docker info >/dev/null 2>&1 || fail 'Docker daemon unavailable'
}
TTY=(); [[ -t 0 && -t 1 ]] || TTY=(-T)
if [[ $COMMAND == init ]]; then initialize; exit 0; fi
docker_check
if [[ $COMMAND == up || $COMMAND == reset ]]; then initialize; fi
[[ -f $ENVFILE ]] || fail "Missing $ENVFILE; run init (or demo up)"
# --quiet validates without emitting expanded secrets.
"${DC[@]}" config --quiet
case "$COMMAND" in
  doctor) node_check; printf 'Bash, Node 24, Compose, daemon and configuration OK (%s).\n' "$PROJECT" ;;
  build) "${DC[@]}" build ;;
  up) "${DC[@]}" up -d --build --wait --wait-timeout 180 ;;
  start|stop|restart|down) "${DC[@]}" "$COMMAND" ;;
  status) "${DC[@]}" ps -a ;;
  health) "${DC[@]}" exec -T app node -e 'fetch("http://localhost:8080/api/health").then(r=>{if(!r.ok)process.exit(1);console.log("Application ready")}).catch(()=>process.exit(1))' ;;
  logs)
    FOLLOW=(); if [[ ${1:-} == --follow ]]; then FOLLOW=(--follow); shift; fi
    for service in "$@"; do [[ $service != -* ]] || fail 'Invalid service'; done
    "${DC[@]}" logs --tail 100 "${FOLLOW[@]}" "$@" ;;
  shell) [[ $# -le 1 && ${1:-app} != -* ]] || fail 'Usage: shell [service]'; "${DC[@]}" exec "${TTY[@]}" "${1:-app}" sh ;;
  db)
    # Expand these variables in the database container, not on the host.
    # shellcheck disable=SC2016
    "${DC[@]}" exec "${TTY[@]}" db sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@" ;;
  migrate) "${DC[@]}" run --rm -T migrate ;;
  admin) "${DC[@]}" exec "${TTY[@]}" app node dist/admin-cli.js ;;
  backup)
    [[ $# -le 1 ]] || fail 'Usage: backup [path]'
    DEST=${1:-"$ROOT/backups/$PROJECT-$(date -u +%Y%m%dT%H%M%SZ).dump"}
    [[ $DEST == /* ]] || DEST="$ROOT/$DEST"
    mkdir -p -- "$(dirname -- "$DEST")"
    umask 077
    (set -o noclobber; : > "$DEST") 2>/dev/null || fail 'Backup destination exists or cannot be created'
    trap 'rm -f -- "$DEST"' EXIT
    # Expand database credentials inside the container.
    # shellcheck disable=SC2016
    "${DC[@]}" exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DEST"
    trap - EXIT
    printf 'Backup saved: %s\n' "$DEST" ;;
  seed) "${DC[@]}" run --rm -T seed ;;
  accounts|summary) "${DC[@]}" exec -T app node dist/demo/cli.js "$COMMAND" ;;
  armory) [[ $# == 2 ]] || fail 'Usage: demo armory <email> <state>'; "${DC[@]}" exec -T app node dist/demo/cli.js armory "$@" ;;
  check) [[ $# == 1 ]] || fail 'Usage: demo check <email>'; "${DC[@]}" exec -T app node dist/demo/cli.js check "$@" ;;
  reset)
    [[ $# == 1 && $1 == --yes ]] || fail 'Usage: demo reset --yes'
    "${DC[@]}" down --volumes
    "${DC[@]}" up -d --build --wait --wait-timeout 180 ;;
esac
