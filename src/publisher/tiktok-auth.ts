/**
 * TikTok OAuth (Login Kit v2) + token lifecycle.
 *
 * TikTok access tokens last ~24 h and refresh tokens ~1 year, so tokens live
 * in the oauth_tokens table (the system rewrites them on every refresh) rather
 * than in .env. TIKTOK_ACCESS_TOKEN / TIKTOK_OPEN_ID in .env still work as a
 * manual fallback, but they stop working after a day.
 *
 * One-time setup (src/scripts/tiktok-auth.ts):
 *   1. print the authorize URL, open it, approve with the posting account
 *   2. TikTok redirects to TIKTOK_REDIRECT_URI?code=...  (the page itself
 *      may 404 — only the code in the address bar matters)
 *   3. paste the code (or the whole URL) back into the script → tokens saved
 * After that, getTikTokCredentials() refreshes automatically.
 *
 * Endpoints: https://developers.tiktok.com/doc/oauth-user-access-token-management
 */

import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { child } from "../lib/logger.ts";

const log = child("publisher.tiktok-auth");
const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
export const TIKTOK_SCOPES = ["user.info.basic", "video.publish", "video.upload"];
/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  open_id?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface TikTokCredentials {
  accessToken: string;
  openId: string;
  source: "db" | "env";
  expiresAt?: Date;
}

function requireApp(): { key: string; secret: string } {
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
    throw new Error("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET not set");
  }
  return { key: env.TIKTOK_CLIENT_KEY, secret: env.TIKTOK_CLIENT_SECRET };
}

export function authorizeUrl(state: string): string {
  const { key } = requireApp();
  if (!env.TIKTOK_REDIRECT_URI) throw new Error("TIKTOK_REDIRECT_URI not set (must match the app's Login Kit redirect URI)");
  const q = new URLSearchParams({
    client_key: key,
    scope: TIKTOK_SCOPES.join(","),
    response_type: "code",
    redirect_uri: env.TIKTOK_REDIRECT_URI,
    state,
  });
  return `${AUTHORIZE_URL}?${q}`;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(`TikTok token ${res.status}: ${data.error ?? ""} ${data.error_description ?? ""}`.trim());
  }
  return data;
}

async function saveTokens(t: TokenResponse): Promise<TikTokCredentials> {
  const now = Date.now();
  const row = {
    provider: "tiktok",
    accessToken: t.access_token!,
    refreshToken: t.refresh_token ?? null,
    accountId: t.open_id ?? null,
    scope: t.scope ?? null,
    expiresAt: new Date(now + (t.expires_in ?? 86400) * 1000),
    refreshExpiresAt: t.refresh_expires_in ? new Date(now + t.refresh_expires_in * 1000) : null,
    updatedAt: new Date(),
  };
  await db.insert(schema.oauthTokens).values(row).onConflictDoUpdate({ target: schema.oauthTokens.provider, set: row });
  return { accessToken: row.accessToken, openId: row.accountId ?? "", source: "db", expiresAt: row.expiresAt };
}

/** Accepts the raw code or the full redirect URL TikTok sent the browser to. */
export async function exchangeCode(codeOrUrl: string): Promise<TikTokCredentials> {
  const { key, secret } = requireApp();
  let code = codeOrUrl.trim();
  if (code.startsWith("http")) {
    const u = new URL(code);
    const err = u.searchParams.get("error");
    if (err) throw new Error(`TikTok authorization refused: ${err} ${u.searchParams.get("error_description") ?? ""}`);
    code = u.searchParams.get("code") ?? "";
  }
  if (!code) throw new Error("no authorization code found");
  const t = await tokenRequest({
    client_key: key,
    client_secret: secret,
    code: decodeURIComponent(code),
    grant_type: "authorization_code",
    redirect_uri: env.TIKTOK_REDIRECT_URI ?? "",
  });
  log.info({ openId: t.open_id, scope: t.scope }, "tiktok authorized");
  return saveTokens(t);
}

export async function refreshTikTokToken(): Promise<TikTokCredentials | null> {
  const [row] = await db.select().from(schema.oauthTokens).where(eq(schema.oauthTokens.provider, "tiktok")).limit(1);
  if (!row?.refreshToken) return null;
  const { key, secret } = requireApp();
  const t = await tokenRequest({
    client_key: key,
    client_secret: secret,
    grant_type: "refresh_token",
    refresh_token: row.refreshToken,
  });
  // TikTok may rotate the refresh token; keep the old one if it didn't send a new one.
  const saved = await saveTokens({ ...t, refresh_token: t.refresh_token ?? row.refreshToken, open_id: t.open_id ?? row.accountId ?? undefined });
  log.info({ expiresAt: saved.expiresAt }, "tiktok token refreshed");
  return saved;
}

/**
 * A usable access token + open_id, refreshing first when it's about to
 * expire. Returns null when TikTok isn't set up (caller → dry-run).
 */
export async function getTikTokCredentials(): Promise<TikTokCredentials | null> {
  const [row] = await db.select().from(schema.oauthTokens).where(eq(schema.oauthTokens.provider, "tiktok")).limit(1);
  if (row) {
    if (row.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return { accessToken: row.accessToken, openId: row.accountId ?? "", source: "db", expiresAt: row.expiresAt };
    }
    try {
      const fresh = await refreshTikTokToken();
      if (fresh) return fresh;
    } catch (err) {
      log.error({ err: String(err) }, "tiktok token refresh failed — re-run src/scripts/tiktok-auth.ts");
      if (row.expiresAt.getTime() > Date.now()) {
        return { accessToken: row.accessToken, openId: row.accountId ?? "", source: "db", expiresAt: row.expiresAt };
      }
      return null;
    }
  }
  if (env.TIKTOK_ACCESS_TOKEN && env.TIKTOK_OPEN_ID) {
    return { accessToken: env.TIKTOK_ACCESS_TOKEN, openId: env.TIKTOK_OPEN_ID, source: "env" };
  }
  return null;
}
