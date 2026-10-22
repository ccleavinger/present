#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if (($#)); then
  action="$1"
  shift
else
  action="up"
fi

print_url() {
  local host_port
  host_port="$(docker compose port present-web 80 2>/dev/null | sed -n '1s/.*://p')"
  printf 'Present is running at http://localhost:%s\n' "${host_port:-${PRESENT_PORT:-3000}}"
}

case "$action" in
  up)
    docker compose up --build --remove-orphans -d "$@"
    print_url
    ;;
  rebuild)
    docker compose build --no-cache "$@"
    docker compose up -d --force-recreate --remove-orphans "$@"
    print_url
    ;;
  down)
    docker compose down "$@"
    ;;
  logs)
    docker compose logs -f "$@"
    ;;
  status)
    docker compose ps "$@"
    ;;
  help|-h|--help)
    cat <<'USAGE'
Usage: ./present.sh [command]

Commands:
  up       Build if needed and start Present in the background (default)
  rebuild  Rebuild without cache and recreate the container
  down     Stop and remove the container (deck data is preserved)
  logs     Follow container logs
  status   Show container status
  help     Show this help
USAGE
    ;;
  *)
    printf 'Unknown command: %s\n\n' "$action" >&2
    printf 'Run ./present.sh help for usage.\n' >&2
    exit 2
    ;;
esac
