# affiliate-ai — notes for Claude

Shopee affiliate bot for the Thai Facebook Page "Meesukdorm". It scrapes
Shopee products, scores them, writes Thai captions with Claude, makes short
voiced product videos, and posts them on a schedule. The owner writes in
Thai; answer in Thai.

## Safety rules (always)

- **Never post live without the owner's explicit OK in chat.** `DEBUG_DRY_RUN`
  in `.env` decides whether posts are real. Never change `DEBUG_DRY_RUN`,
  `FEATURE_*_AUTO_POST` or any `.env` value without asking, and say what you
  changed.
- Never print, log, commit or paste secrets (`.env`, tokens, keys). When you
  need to show `.env`, mask values: `sed -E 's/=.+/=<set>/'`.
- Never post the demo seed products (`flag_reason = 'demo seed data — never post'`,
  `is_active = false`). Don't reactivate them.
- Paid calls cost the owner money: a Kling clip on fal.ai is about 23–25 baht,
  ElevenLabs uses credits, Apify scrapes are capped at $2/day. Ask before
  running paid tests that weren't requested.
- Only one copy of the stack may post to the Page. Production now runs on the
  **VPS**; the owner's Windows PC copy is stopped. Never start both with
  `DEBUG_DRY_RUN=false`, or the Page gets duplicate posts.
- Commit or push only when asked. Work on branch `video-pipeline`.

## Stack

Bun + TypeScript, Drizzle ORM (Postgres 16), Croner scheduler (TZ
Asia/Bangkok), Next.js dashboard, Docker Compose. Claude models:
`claude-haiku-5-5` (fast tier), `claude-sonnet-5-5` (smart tier). Both think
before answering, so keep `maxTokens` large (3000–6000) or JSON gets cut off.

```
src/scraper/      Apify Shopee scrapes
src/brain/        product-scorer.ts (final_score), daily-captions.ts, learning
src/content/      captions, video-script.ts (Sonnet), voice-generator.ts
                  (ElevenLabs eleven_v3 — flash models garble Thai),
                  fal-kling.ts (Kling 2.5 Turbo Pro), wangp-client.ts (local GPU, PC only),
                  video-pipeline.ts (script → voice → clip → ffmpeg 1080×1920)
src/quality/      Quality Gate (every caption passes it before posting)
src/publisher/    facebook.ts, auto-publish.ts (photo rounds), auto-video.ts,
                  tiktok.ts + tiktok-auth.ts (prepared, not live)
src/affiliate/    link-generator.ts (LINK_MODE), shopee-api.ts, shopee-report.ts
src/engagement/   FB metrics (needs read_insights on the Meta token)
src/scheduler/    index.ts (job list), jobs.ts
src/dashboard/    Next.js dashboard (port 3100, localhost-only)
src/db/           schema.ts + migrations (drizzle-kit)
src/scripts/      one-off tools (test-video-post.ts, rescore-products.ts, …)
install-ubuntu.sh one-shot server installer (--update, --with-claude, …)
```

## Schedule (Asia/Bangkok)

- Photo posts: `PHOTO_POST_TIMES` (default 12:10, 18:10, 20:40), max
  `DAILY_POSTS_FACEBOOK` (3) per day.
- Video post: `CRON_VIDEO_POST` (owner wants `0 20 * * *`; code default 22:30).
  Uses Kling when `FAL_KEY` is set, else WanGP (only on the owner's PC).
- Daily captions 07:30, scrapes 08/13/19/22, promo hunter every 30 min,
  engagement every 2 h, learning 03:00, Shopee report every 6 h.
- Translations (EN/ZH/JA) are off: `FEATURE_AUTO_TRANSLATE=false`.

## Commands

```bash
docker compose ps
docker compose logs -f scheduler            # look for the "capabilities" line
docker compose up -d --force-recreate       # after editing .env
docker compose up -d --build scheduler      # after code changes
docker compose exec scheduler bun run src/scripts/<script>.ts
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
bun install && bunx tsc --noEmit -p .       # typecheck on the host
sudo bash install-ubuntu.sh --update        # pull + rebuild + restart
```

Use `"$POSTGRES_USER"`/`"$POSTGRES_DB"` inside the db container; don't guess
the role name. After a code change: typecheck, rebuild the affected service,
check its logs.

## Links and money

- No product website on the VPS (`SITE_ENABLED=false`, no domain).
- `LINK_MODE=auto`: with Shopee Open API keys → Shopee short links with
  subIds (clicks and sales come back via `shopee-report.ts`); without them →
  plain product URLs (no commission tracking).

## Waiting on the owner

- Shopee Open API approval (`SHOPEE_API_KEY`/`SECRET`), then check the
  conversion report fields with `shopee-report.ts --raw`.
- Meta token with `read_insights` (FB views/clicks are empty without it).
- TikTok app (see `docs/tiktok-setup.md`).
