# Install on Ubuntu 24.04

`install-ubuntu.sh` sets up a server in one run: Docker Engine + Compose,
the code, a safe `.env`, all containers, and the static site.

## Quick start

On a fresh Ubuntu 24.04 server (2 GB RAM or more recommended; the script adds
swap on smaller machines):

```bash
curl -fsSL https://raw.githubusercontent.com/makpdkpp/affiliate-ai/video-pipeline/install-ubuntu.sh -o install-ubuntu.sh
sudo bash install-ubuntu.sh
```

Or from a clone: `sudo bash install-ubuntu.sh`.

It asks for a few keys. Press Enter to skip any of them; the feature that
needs it stays off.

| Prompt | Used for |
|---|---|
| Anthropic API key | captions, moderation (Quality Gate) |
| Apify token | Shopee scraping |
| Shopee affiliate ID | your affiliate account |
| Shopee Open Affiliate API app ID + secret | once approved: posts link straight to Shopee with commission-tracked short links, and sales/commission are synced every 6 h |
| Domain (optional) | only for the product website + `/go/` links; Enter = no website, no domain needed |
| Facebook Page ID + token | posting (a Page token or a long-lived token of a Page admin) |
| fal.ai key | daily 22:30 product video via Kling 2.5 Turbo Pro (~$0.70 per 10 s clip); no key = no video |
| ElevenLabs key + voice ID | the Thai voiceover on those videos |

Non-interactive:

```bash
sudo ANTHROPIC_API_KEY=... APIFY_TOKEN=... SITE_DOMAIN=shop.example.com bash install-ubuntu.sh --yes
```

## What it sets up

- **Safe defaults**: `DEBUG_DRY_RUN=true` (nothing is posted),
  `AUTO_DEPLOY_AFTER_REBUILD=false`, and video only if you entered a fal.ai
  key (`FAL_KEY`; otherwise the 22:30 video job skips itself). A random `DASHBOARD_PASSWORD` and
  `INTERNAL_AUTH_SECRET` are generated. `.env` is mode 600.
- **Ports**: only the public site (when enabled) listens on all interfaces
  (`WEB_PORT`, default 8080; it also proxies `/go/` to the redirect server). Postgres,
  Adminer, Drizzle Studio, the redirect server and the dashboard bind to
  127.0.0.1. Docker publishes ports past ufw, so this is what keeps them
  private.
- Containers restart on their own after a reboot (`restart: unless-stopped`).

## Day to day

```bash
cd /opt/affiliate-ai
sudo docker compose logs -f scheduler   # what the bot is doing
sudo docker compose ps
```

Dashboard from your PC (it is localhost-only on the server):

```bash
ssh -L 3100:127.0.0.1:3100 you@SERVER_IP
# then open http://localhost:3100
```

Go live: set `DEBUG_DRY_RUN=false` in `.env`, then
`sudo docker compose up -d --force-recreate`.

Update to the latest code (keeps `.env` and the database):

```bash
sudo bash /opt/affiliate-ai/install-ubuntu.sh --update
```

## Options

| Option | Effect |
|---|---|
| `--update` | git pull, rebuild, restart |
| `--env-only` | only create/fix `.env` |
| `--yes` | never prompt; read keys from the environment |
| `--dir PATH` | install directory when cloning (default `/opt/affiliate-ai`) |
| `--branch NAME` | branch to check out (default `video-pipeline`) |
| `--expose-dashboard` | publish the dashboard on all interfaces (put HTTPS in front and set `DASHBOARD_SECURE_COOKIE=true`) |
| `--no-swap` | don't add a swap file on low-memory machines |

## Links, clicks and sales (no domain needed)

`LINK_MODE=auto` picks the link that goes into each post:

| Configured | Link in posts | Clicks from | Sales / commission from |
|---|---|---|---|
| Shopee Open API keys | Shopee short link with subIds (channel, link id, campaign, caption) | Facebook Insights (engagement tracker, every 2 h) | Shopee conversion report (every 6 h) → `affiliate_conversions`, mapped back to the post |
| No keys, website on | `https://DOMAIN/go/<id>` | our redirect server | — |
| No keys, no website | plain Shopee product URL (no commission tracking) | Facebook Insights | — |

The product website is optional (`SITE_ENABLED`, `COMPOSE_PROFILES=site`).
Without it there is no `web`/`redirect` container and no domain or HTTPS to
pay for.

After the Shopee Open API is approved, check the report fields once:

```bash
sudo docker compose exec scheduler bun run src/scripts/shopee-report.ts --raw
```

### If you do run the website

Links are built from `SITE_DOMAIN` / `DOMAIN_NAME` as `https://…`, so the
domain must reach this server over HTTPS. Easiest options: a Cloudflare
Tunnel to `http://127.0.0.1:8080`, or Caddy/nginx with a certificate in front
of port 8080.
