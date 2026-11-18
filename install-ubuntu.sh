#!/usr/bin/env bash
# =============================================================================
# affiliate-ai — one-shot installer for Ubuntu 24.04 LTS
#
#   Installs Docker Engine + Compose, gets the code, writes a safe .env
#   (dry-run ON, video OFF), builds and starts every container, builds the
#   static site, and checks that it all answers.
#
# Usage
#   From a clone:     sudo bash install-ubuntu.sh
#   On a bare server: curl -fsSL https://raw.githubusercontent.com/makpdkpp/affiliate-ai/video-pipeline/install-ubuntu.sh -o install-ubuntu.sh
#                     sudo bash install-ubuntu.sh
#
# Options
#   --update             git pull + rebuild + restart (keeps .env and the database)
#   --env-only           only create/fix .env, then exit
#   --yes                non-interactive: never prompt (take keys from the environment)
#   --dir PATH           install directory when cloning (default /opt/affiliate-ai)
#   --branch NAME        git branch to check out (default video-pipeline)
#   --expose-dashboard   publish the dashboard on all interfaces (default: localhost only)
#   --no-swap            don't create a swap file on low-memory machines
#   -h, --help
#
# Keys can be passed non-interactively, e.g.
#   sudo ANTHROPIC_API_KEY=... APIFY_TOKEN=... SITE_DOMAIN=shop.example.com bash install-ubuntu.sh --yes
# =============================================================================
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/makpdkpp/affiliate-ai.git}"
BRANCH="${BRANCH:-video-pipeline}"
INSTALL_DIR="${INSTALL_DIR:-/opt/affiliate-ai}"
WEB_PORT_DEFAULT=8080

MODE=install
ASSUME_YES=0
EXPOSE_DASHBOARD=0
MAKE_SWAP=1

# ---------- output helpers ----------
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B='' G='' Y='' R='' C='' N=''; fi
step() { printf '\n%s==>%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
ok()   { printf '   %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '   %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '\n%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

usage() { awk 'NR > 2 && /^# =+$/ { exit } NR > 2 { sub(/^# ?/, ""); print }' "$0"; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --update) MODE=update ;;
    --env-only) MODE="env" ;;
    --yes|-y) ASSUME_YES=1 ;;
    --dir) INSTALL_DIR="$2"; shift ;;
    --branch) BRANCH="$2"; shift ;;
    --expose-dashboard) EXPOSE_DASHBOARD=1 ;;
    --no-swap) MAKE_SWAP=0 ;;
    -h|--help) usage ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

# ---------- preflight ----------
[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0 $*"
TARGET_USER="${SUDO_USER:-root}"
# Prompts read from /dev/tty, so they work even under `curl ... | sudo bash`.
if [[ $ASSUME_YES -eq 0 ]] && (: < /dev/tty) 2>/dev/null; then INTERACTIVE=1; else INTERACTIVE=0; fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    die "this installer targets Ubuntu (found ${PRETTY_NAME:-unknown})"
  elif [[ "${VERSION_ID:-}" != "24.04" ]]; then
    warn "tested on Ubuntu 24.04 — found ${PRETTY_NAME}; continuing"
  fi
fi

# Where is the code? Next to this script if it's a checkout, else clone.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$PWD/x}")" && pwd)"
if [[ -f "$SCRIPT_DIR/docker-compose.yml" && -f "$SCRIPT_DIR/.env.example" ]]; then
  APP_DIR="$SCRIPT_DIR"
else
  APP_DIR="$INSTALL_DIR"
fi
ENV_FILE="$APP_DIR/.env"

# ---------- .env helpers ----------
get_env() { [[ -f "$ENV_FILE" ]] && grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }

set_env() { # set_env KEY VALUE — replace or append, value taken literally
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    K="$key" V="$val" awk 'index($0, ENVIRON["K"] "=") == 1 { print ENVIRON["K"] "=" ENVIRON["V"]; next } { print }' \
      "$ENV_FILE" > "$ENV_FILE.tmp"
    cat "$ENV_FILE.tmp" > "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

default_env() { [[ -n "$(get_env "$1")" ]] || set_env "$1" "$2"; }

ask() { # ask KEY "question" [secret] — only when empty and interactive; env var wins
  local key="$1" q="$2" secret="${3:-}" cur from_env ans=""
  cur="$(get_env "$key")"
  from_env="${!key:-}"
  if [[ -n "$from_env" ]]; then set_env "$key" "$from_env"; return; fi
  [[ -n "$cur" || $INTERACTIVE -eq 0 ]] && return
  if [[ -n "$secret" ]]; then
    read -r -s -p "   $q: " ans < /dev/tty; echo
  else
    read -r -p "   $q: " ans < /dev/tty
  fi
  [[ -n "$ans" ]] && set_env "$key" "$ans"
  return 0
}

rand() { openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c "${1:-24}"; }

# ---------- steps ----------
install_packages() {
  step "Installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg git openssl >/dev/null
  ok "curl, git, openssl"
}

install_docker() {
  step "Docker Engine + Compose"
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    ok "already installed: $(docker --version | cut -d, -f1), compose $(docker compose version --short)"
  else
    # Distro packages conflict with Docker's own repo.
    for p in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
      dpkg -s "$p" >/dev/null 2>&1 && apt-get remove -y -qq "$p" >/dev/null || true
    done
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-${VERSION_CODENAME:-noble}} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
    ok "installed $(docker --version | cut -d, -f1), compose $(docker compose version --short)"
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  if [[ "$TARGET_USER" != "root" ]] && ! id -nG "$TARGET_USER" | grep -qw docker; then
    usermod -aG docker "$TARGET_USER"
    ok "added $TARGET_USER to the docker group (log out and back in to use docker without sudo)"
  fi
}

ensure_swap() {
  [[ $MAKE_SWAP -eq 1 ]] || return 0
  local mem_mb; mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  if (( mem_mb < 3500 )) && ! swapon --show | grep -q .; then
    step "Low memory (${mem_mb} MB, no swap) — adding a 4 GB swap file for image builds"
    fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap on (disable with --no-swap next time)"
  fi
}

get_code() {
  step "Code"
  if [[ "$APP_DIR" == "$SCRIPT_DIR" ]]; then
    if [[ $MODE == update && -d "$APP_DIR/.git" ]]; then
      git -C "$APP_DIR" pull -q --ff-only
      ok "pulled $(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD) @ $(git -C "$APP_DIR" rev-parse --short HEAD)"
    else
      ok "using this checkout: $APP_DIR"
    fi
    return
  fi
  if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" fetch -q origin
    git -C "$APP_DIR" checkout -q "$BRANCH"
    git -C "$APP_DIR" pull -q --ff-only origin "$BRANCH"
    ok "updated $APP_DIR ($BRANCH @ $(git -C "$APP_DIR" rev-parse --short HEAD))"
  else
    git clone -q --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    ok "cloned $REPO_URL ($BRANCH) → $APP_DIR"
  fi
  chown -R "$TARGET_USER":"$TARGET_USER" "$APP_DIR"
}

setup_env() {
  step "Configuration (.env)"
  local fresh=0
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$APP_DIR/.env.example" "$ENV_FILE"
    fresh=1
    ok "created .env from .env.example"
  else
    cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
    ok "kept existing .env (backup saved next to it)"
  fi

  # Compose reads `KEY=value   # note` as the whole value, so drop inline comments.
  sed -i -E '/^[A-Z_][A-Z0-9_]*=/ { s/^([A-Z_][A-Z0-9_]*=)#.*$/\1/; s/[[:space:]]+#.*$//; }' "$ENV_FILE"
  sed -i 's/\r$//' "$ENV_FILE"

  if [[ $fresh -eq 1 ]]; then
    # Safe starting point: nothing is posted, nothing is deployed, no video.
    set_env DEBUG_DRY_RUN true
    set_env AUTO_DEPLOY_AFTER_REBUILD false
    set_env NODE_ENV production
    set_env WANGP_URL ""
    set_env ANTHROPIC_MODEL_FAST claude-haiku-5-5
    set_env ANTHROPIC_MODEL_SMART claude-sonnet-5-5
    set_env ANTHROPIC_MODEL_PRO claude-opus-5-5
    set_env ELEVENLABS_MODEL eleven_v3
  fi
  # Known-bad values from the template (the site build can't replace a mounted dir).
  [[ "$(get_env SITE_OUT_DIR)" == "./out/dist" ]] || set_env SITE_OUT_DIR ./out/dist
  default_env TIMEZONE Asia/Bangkok
  default_env DASHBOARD_PASSWORD "$(rand 20)"
  default_env DASHBOARD_SECURE_COOKIE false
  default_env INTERNAL_AUTH_SECRET "$(rand 40)"
  default_env WEB_PORT "$WEB_PORT_DEFAULT"
  [[ $EXPOSE_DASHBOARD -eq 1 ]] && set_env DASHBOARD_BIND 0.0.0.0

  if [[ $INTERACTIVE -eq 1 ]]; then
    echo "   Press Enter to skip any key — the matching feature just stays off."
  fi
  ask ANTHROPIC_API_KEY "Anthropic API key (captions, moderation)" secret
  ask APIFY_TOKEN "Apify token (Shopee scraping)" secret
  ask SHOPEE_AFFILIATE_ID "Shopee affiliate ID (af_id in links)"
  ask SITE_DOMAIN "Public domain for the site and /go/ links, e.g. shop.example.com"
  [[ -n "$(get_env DOMAIN_NAME)" && "$(get_env DOMAIN_NAME)" != "example.com" ]] || set_env DOMAIN_NAME "$(get_env SITE_DOMAIN)"
  ask META_PAGE_ID "Facebook Page ID (optional)"
  ask META_PAGE_ACCESS_TOKEN "Facebook Page or admin user token (optional)" secret

  chmod 600 "$ENV_FILE"
  chown "$TARGET_USER":"$TARGET_USER" "$ENV_FILE"
  local dash="localhost only"
  [[ "$(get_env DASHBOARD_BIND)" == "0.0.0.0" ]] && dash="all interfaces (password-protected)"
  ok "dry-run: $(get_env DEBUG_DRY_RUN) · video: $( [[ -n "$(get_env WANGP_URL)" ]] && echo on || echo off) · dashboard: $dash"
}

start_stack() {
  step "Building images and starting containers (first build takes a few minutes)"
  cd "$APP_DIR"
  mkdir -p site-out/video
  chown -R "$TARGET_USER":"$TARGET_USER" site-out
  docker compose build -q
  docker compose up -d --remove-orphans
  ok "containers up (migrations applied)"

  step "Building the static site"
  docker compose --profile tools run --rm site-build >/dev/null
  ok "site written to site-out/dist"
}

health() {
  step "Health checks"
  local port; port="$(get_env WEB_PORT)"; port="${port:-$WEB_PORT_DEFAULT}"
  local fails=0
  check() { # check NAME URL
    local code
    for _ in $(seq 1 30); do
      code=$(curl -s -o /dev/null -w '%{http_code}' "$2" || true)
      [[ "$code" =~ ^(200|301|302|307|308)$ ]] && { ok "$1 ($2 → $code)"; return 0; }
      sleep 2
    done
    warn "$1 not answering yet ($2 → ${code:-none}) — see: docker compose logs"; fails=$((fails + 1))
  }
  check "public site"     "http://127.0.0.1:${port}/"
  check "redirect server" "http://127.0.0.1:3001/health"
  check "dashboard"       "http://127.0.0.1:3100/login"
  docker compose ps --format '   {{.Service}}: {{.Status}}'
  return 0
}

summary() {
  local ip port pw
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  port="$(get_env WEB_PORT)"; port="${port:-$WEB_PORT_DEFAULT}"
  pw="$(get_env DASHBOARD_PASSWORD)"
  local dash_how="localhost-only → from your PC:  ssh -L 3100:127.0.0.1:3100 ${TARGET_USER}@${ip:-SERVER_IP}
                     then open http://localhost:3100"
  [[ "$(get_env DASHBOARD_BIND)" == "0.0.0.0" ]] && dash_how="http://${ip:-SERVER_IP}:3100  (public — use HTTPS + DASHBOARD_SECURE_COOKIE=true)"
  cat <<EOF

${G}${B}affiliate-ai is running.${N}  (${APP_DIR})

  Public site        http://${ip:-SERVER_IP}:${port}/   (put HTTPS in front: Cloudflare Tunnel, Caddy or nginx)
  Dashboard          ${dash_how}
                     password: ${pw}   (DASHBOARD_PASSWORD in .env)
  Adminer / Studio   same way: ssh -L 8081:127.0.0.1:8081 -L 4983:127.0.0.1:4983 ...

  ${Y}DEBUG_DRY_RUN=$(get_env DEBUG_DRY_RUN)${N} — nothing is posted until you set it to false in .env and run:
      cd ${APP_DIR} && sudo docker compose up -d --force-recreate
  Video posts are off (WANGP_URL empty) — the 22:30 job skips itself.

  Logs      cd ${APP_DIR} && sudo docker compose logs -f scheduler
  Update    sudo bash ${APP_DIR}/install-ubuntu.sh --update
  Domain    /go/ links in posts use SITE_DOMAIN/DOMAIN_NAME = '$(get_env SITE_DOMAIN)'
EOF
  [[ "$(get_env SITE_DOMAIN)" =~ ^(|example\.com)$ ]] && warn "SITE_DOMAIN is not set — links in posts won't work until it points at this server"
  return 0
}

# ---------- main ----------
case "$MODE" in
  env)
    [[ -f "$APP_DIR/.env.example" ]] || die "no checkout found at $APP_DIR"
    setup_env
    ;;
  update)
    [[ -d "$APP_DIR" ]] || die "nothing installed at $APP_DIR"
    get_code
    setup_env
    start_stack
    health
    summary
    ;;
  install)
    install_packages
    install_docker
    ensure_swap
    get_code
    setup_env
    start_stack
    health
    summary
    ;;
esac
