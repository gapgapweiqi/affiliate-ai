/**
 * TikTok one-time authorization + token tools.
 *
 *   bun run src/scripts/tiktok-auth.ts                 print the authorize URL
 *   bun run src/scripts/tiktok-auth.ts --code <code|redirect URL>
 *                                                      exchange the code, save tokens
 *   bun run src/scripts/tiktok-auth.ts --refresh       refresh the access token now
 *   bun run src/scripts/tiktok-auth.ts --status        token expiry + what the account may post
 *
 * Needs TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI in .env
 * (the redirect URI must match the one registered in the app's Login Kit).
 */

import { closeDb } from "../lib/db.ts";
import { authorizeUrl, exchangeCode, getTikTokCredentials, refreshTikTokToken, TIKTOK_SCOPES } from "../publisher/tiktok-auth.ts";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const valueOf = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  if (flag("--code")) {
    const code = valueOf("--code");
    if (!code) throw new Error("usage: --code <code or the full redirect URL>");
    const c = await exchangeCode(code);
    console.log(`✓ TikTok authorized. open_id=${c.openId}, access token valid until ${c.expiresAt?.toISOString()}`);
    console.log("  The scheduler refreshes it automatically from now on.");
    return;
  }
  if (flag("--refresh")) {
    const c = await refreshTikTokToken();
    console.log(c ? `✓ refreshed, valid until ${c.expiresAt?.toISOString()}` : "no saved TikTok token — run without flags first");
    return;
  }
  if (flag("--status")) {
    const c = await getTikTokCredentials();
    if (!c) {
      console.log("TikTok not set up (no saved token, no TIKTOK_ACCESS_TOKEN).");
      return;
    }
    console.log(`token source: ${c.source}${c.expiresAt ? `, valid until ${c.expiresAt.toISOString()}` : ""}`);
    const res = await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", {
      method: "POST",
      headers: { Authorization: `Bearer ${c.accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
      body: "{}",
    });
    const j = (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } };
    if (j.error && j.error.code !== "ok") console.log(`creator_info error: ${j.error.code} ${j.error.message}`);
    else {
      console.log(`account: @${j.data?.creator_username} (${j.data?.creator_nickname})`);
      console.log(`allowed privacy: ${JSON.stringify(j.data?.privacy_level_options)}  ← only SELF_ONLY = app not audited yet`);
      console.log(`max video length: ${j.data?.max_video_post_duration_sec}s`);
    }
    return;
  }

  const state = crypto.randomUUID().slice(0, 8);
  console.log("1) Open this URL while logged in to the TikTok account that should post:\n");
  console.log(`   ${authorizeUrl(state)}\n`);
  console.log(`   (scopes: ${TIKTOK_SCOPES.join(", ")})`);
  console.log("2) Approve. The browser lands on your redirect URI with ?code=... (that page may 404 — fine).");
  console.log("3) Copy the whole address-bar URL and run:\n");
  console.log(`   bun run src/scripts/tiktok-auth.ts --code "<paste URL here>"`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
