#!/usr/bin/env bash
# =============================================================================
# affiliate-ai — one-shot installer for Ubuntu 24.04 LTS
#
#   Installs Docker Engine + Compose, gets the code, writes a safe .env
#   (dry-run ON; video only if you give a fal.ai key), builds and starts every container, builds the
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
#   --with-claude        also install Claude Code (+ Bun, tmux) for the login user,
#                        so Claude can work on this server remotely (4 GB RAM advised)
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
WITH_CLAUDE=0

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
    --with-claude) WITH_CLAUDE=1 ;;
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

site_on() { [[ "$(get_env SITE_ENABLED)" == "true" ]]; }

link_status() {
  if [[ "$(get_env LINK_MODE)" == "redirect" ]]; then echo "/go/ redirect on $(get_env SITE_DOMAIN)"
  elif [[ -n "$(get_env SHOPEE_API_KEY)" && -n "$(get_env SHOPEE_API_SECRET)" ]]; then echo "Shopee short links (commission-tracked)"
  elif site_on; then echo "/go/ redirect on $(get_env SITE_DOMAIN) until the Shopee API keys are added"
  else echo "plain Shopee product URLs until the Shopee API keys are added (not commission-tracked yet)"; fi
}

video_status() {
  if [[ -n "$(get_env FAL_KEY)" ]]; then echo "on (Kling via fal.ai, 22:30 daily)"
  elif [[ -n "$(get_env WANGP_URL)" ]]; then echo "on (WanGP at $(get_env WANGP_URL))"
  else echo "off"; fi
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

# Claude Code (native installer, per user in ~/.local/bin) + Bun for
# typechecking on the host + tmux so a session survives an SSH drop.
# Installed for the sudo user, who is already in the docker group.
install_claude() {
  step "Claude Code (for remote work on this server)"
  local home
  home=$(getent passwd "$TARGET_USER" | cut -d: -f6)
  [[ -n "$home" ]] || die "can't find the home directory of $TARGET_USER"
  if [[ "$TARGET_USER" == "root" ]]; then
    warn "installing for root — better: create a normal user and run this script with sudo from it"
  fi
  local mem_mb
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  (( mem_mb >= 3500 )) || warn "only ${mem_mb} MB RAM — Claude Code plus builds next to the running stack wants 4 GB"

  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq tmux unzip >/dev/null
  ok "tmux, unzip"

  as_user() { sudo -u "$TARGET_USER" -H bash -lc "$1"; }
  retry3() { local i; for i in 1 2 3; do "$@" && return 0; warn "download failed, retrying ($i/3)"; sleep 5; done; return 1; }
  if as_user 'command -v claude >/dev/null || [ -x ~/.local/bin/claude ]'; then
    ok "Claude Code already installed — updating"
    as_user '~/.local/bin/claude update >/dev/null 2>&1 || claude update >/dev/null 2>&1 || true'
  else
    retry3 as_user 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash' >/dev/null || true   # checked below
  fi
  if ! as_user 'command -v bun >/dev/null || [ -x ~/.bun/bin/bun ]'; then
    retry3 as_user 'set -o pipefail; curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1' || true   # checked below
  fi

  # Make sure both are on PATH in new shells.
  local rc="$home/.bashrc" line
  for line in 'export PATH="$HOME/.local/bin:$PATH"' 'export PATH="$HOME/.bun/bin:$PATH"'; do
    grep -qxF "$line" "$rc" 2>/dev/null || echo "$line" >> "$rc"
  done
  chown "$TARGET_USER":"$TARGET_USER" "$rc"

  local v
  v=$(as_user '~/.local/bin/claude --version 2>/dev/null' || true)
  [[ -n "$v" ]] || die "Claude Code install failed (see https://docs.claude.com/en/docs/claude-code/setup)"
  ok "claude ${v}"
  v=$(as_user '~/.bun/bin/bun --version 2>/dev/null' || true)
  [[ -n "$v" ]] && ok "bun ${v}" || warn "Bun install failed — typechecks on the host won't work (containers are fine)"

  # Dev dependencies so typechecks can run on the host.
  if [[ -f "$APP_DIR/package.json" ]]; then
    as_user "cd '$APP_DIR' && ~/.bun/bin/bun install --frozen-lockfile >/dev/null 2>&1 || ~/.bun/bin/bun install >/dev/null 2>&1" \
      && ok "node_modules installed in $APP_DIR" || warn "bun install failed — run it later in $APP_DIR"
  fi
}

claude_summary() {
  [[ $WITH_CLAUDE -eq 1 ]] || return 0
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  cat <<EOF

  ${B}Claude Code${N}
      ssh ${TARGET_USER}@${ip:-SERVER_IP}
      tmux new -A -s claude          # session keeps running if SSH drops
      cd ${APP_DIR} && claude        # first run: log in with your Claude account (opens a URL)
  Then use Remote Control from inside the session to continue from the Claude app.
  Claude can read .env and restart containers here — keep its permission prompts on.
EOF
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
  ask SHOPEE_AFFILIATE_ID "Shopee affiliate ID"
  ask SHOPEE_API_KEY "Shopee Open Affiliate API app ID (once approved — posts then link straight to Shopee)"
  ask SHOPEE_API_SECRET "Shopee Open Affiliate API secret" secret
  ask SITE_DOMAIN "Domain for the optional product website + /go/ links (Enter = no website, no domain needed)"
  [[ -n "$(get_env DOMAIN_NAME)" && "$(get_env DOMAIN_NAME)" != "example.com" ]] || set_env DOMAIN_NAME "$(get_env SITE_DOMAIN)"
  # The website runs only with a domain; without it posts use Shopee links.
  if [[ "$(get_env SITE_DOMAIN)" =~ ^(|example\.com)$ ]]; then
    set_env SITE_ENABLED false
    set_env COMPOSE_PROFILES ""
  else
    set_env SITE_ENABLED true
    set_env COMPOSE_PROFILES site
  fi
  default_env LINK_MODE auto
  ask META_PAGE_ID "Facebook Page ID (optional)"
  ask META_PAGE_ACCESS_TOKEN "Facebook Page or admin user token (optional)" secret
  ask FAL_KEY "fal.ai key for daily Kling videos, ~\$0.70/clip (optional — Enter = no video)" secret
  ask ELEVENLABS_API_KEY "ElevenLabs API key for the Thai voiceover (optional)" secret
  ask ELEVENLABS_VOICE_ID "ElevenLabs voice ID (optional)"

  chmod 600 "$ENV_FILE"
  chown "$TARGET_USER":"$TARGET_USER" "$ENV_FILE"
  local dash="localhost only"
  [[ "$(get_env DASHBOARD_BIND)" == "0.0.0.0" ]] && dash="all interfaces (password-protected)"
  ok "dry-run: $(get_env DEBUG_DRY_RUN) · video: $(video_status) · dashboard: $dash"
}

start_stack() {
  step "Building images and starting containers (first build takes a few minutes)"
  cd "$APP_DIR"
  mkdir -p site-out/video
  chown -R "$TARGET_USER":"$TARGET_USER" site-out
  docker compose build -q
  docker compose up -d --remove-orphans
  ok "containers up (migrations applied)"

  if site_on; then
    step "Building the static site"
    docker compose --profile tools run --rm site-build >/dev/null
    ok "site written to site-out/dist"
  fi
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
  if site_on; then
    check "public site"     "http://127.0.0.1:${port}/"
    check "redirect server" "http://127.0.0.1:3001/health"
  fi
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

  Public site        $(site_on && echo "http://${ip:-SERVER_IP}:${port}/   (put HTTPS in front: Cloudflare Tunnel, Caddy or nginx)" || echo "off — no domain needed")
  Dashboard          ${dash_how}
                     password: ${pw}   (DASHBOARD_PASSWORD in .env)
  Adminer / Studio   same way: ssh -L 8081:127.0.0.1:8081 -L 4983:127.0.0.1:4983 ...

  ${Y}DEBUG_DRY_RUN=$(get_env DEBUG_DRY_RUN)${N} — nothing is posted until you set it to false in .env and run:
      cd ${APP_DIR} && sudo docker compose up -d --force-recreate
  Video posts: $(video_status)$( [[ -z "$(get_env FAL_KEY)$(get_env WANGP_URL)" ]] && echo " — add FAL_KEY to .env to turn them on")

  Logs      cd ${APP_DIR} && sudo docker compose logs -f scheduler
  Update    sudo bash ${APP_DIR}/install-ubuntu.sh --update
  Links     $(link_status)
EOF
  if [[ -z "$(get_env SHOPEE_API_KEY)" ]] && ! site_on; then
    warn "Until the Shopee Open API keys are in .env, post links are plain product URLs (no commission tracking)."
  fi
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
    [[ $WITH_CLAUDE -eq 1 ]] && install_claude
    health
    summary
    claude_summary
    ;;
  install)
    install_packages
    install_docker
    ensure_swap
    get_code
    setup_env
    start_stack
    [[ $WITH_CLAUDE -eq 1 ]] && install_claude
    health
    summary
    claude_summary
    ;;
esac
