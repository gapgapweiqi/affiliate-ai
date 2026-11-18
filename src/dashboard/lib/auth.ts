// Single-operator password auth (spec suggested Clerk; this needs no
// third-party account). Works in both the Edge middleware and Node runtime.

export const SESSION_COOKIE = "dash_session";

export async function sessionToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`affiliate-ai-dashboard:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isValidSession(cookieValue: string | undefined): Promise<boolean> {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password || !cookieValue) return false;
  const expected = await sessionToken(password);
  if (expected.length !== cookieValue.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ cookieValue.charCodeAt(i);
  return diff === 0;
}
