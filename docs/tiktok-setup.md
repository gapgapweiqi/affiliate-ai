# TikTok setup

The daily 22:30 product video can also go to TikTok. TikTok only takes
video, so TikTok posts come from the video job, never from the photo rounds.

## 1. Get API access

1. Use the TikTok account that should post (Business or Creator).
2. <https://developers.tiktok.com> → **Manage apps → Connect an app**.
3. App details: name, icon, description, and public **Terms of Service** and
   **Privacy Policy** URLs (free hosting is fine: GitHub Pages, Google Sites,
   Notion).
4. Add products **Login Kit** and **Content Posting API** (enable *Direct
   Post*). Scopes: `user.info.basic`, `video.publish`, `video.upload`.
5. Login Kit → **Redirect URI**: any https URL you control. The page doesn't
   have to exist — only the `?code=` TikTok appends to it matters.
6. Try it in the **Sandbox** with your account as a target user, then submit
   for **review/audit** (use case + a demo video). Until the app is audited,
   Direct Post only allows **private (SELF_ONLY)** posts; the publisher
   detects this and posts privately.

## 2. Configure

In `.env`:

```env
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
TIKTOK_REDIRECT_URI=https://your-redirect-url
FEATURE_TIKTOK_AUTO_POST=true
```

Recreate the containers: `docker compose up -d --force-recreate`.

## 3. Authorize once

```bash
docker compose exec scheduler bun run src/scripts/tiktok-auth.ts
```

Open the printed URL while logged in to the posting account and approve. The
browser lands on your redirect URI with `?code=…`. Copy the whole address-bar
URL and run:

```bash
docker compose exec scheduler bun run src/scripts/tiktok-auth.ts --code "<that URL>"
```

Tokens are saved in the `oauth_tokens` table. Access tokens last ~24 h; the
publisher refreshes them before posting and a daily job (03:45) keeps them
fresh. Check anytime:

```bash
docker compose exec scheduler bun run src/scripts/tiktok-auth.ts --status
```

`allowed privacy: ["SELF_ONLY"]` means the app isn't audited yet.

## How posting works

- Video: uploaded directly (`FILE_UPLOAD`), so no domain verification is
  needed. (`PULL_FROM_URL` would require verifying the video host's domain.)
- Caption: the Facebook caption with the link removed (links in TikTok
  captions aren't clickable) plus "link in profile", checked by the Quality
  Gate with TikTok's rules and saved as its own `content_variants` row.
- Put a link page or your Shopee storefront in the TikTok bio. For selling
  directly on TikTok, TikTok Shop Affiliate (the yellow basket) is a separate
  program.
- `DEBUG_DRY_RUN=true` simulates TikTok posts like every other channel.
