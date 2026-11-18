"use server";

import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, isValidSession, sessionToken } from "@/lib/auth";
import { exec } from "@/lib/db";

async function requireSession() {
  const store = await cookies();
  if (!(await isValidSession(store.get(SESSION_COOKIE)?.value))) redirect("/login");
}

function intField(form: FormData, name: string): number {
  const n = Number.parseInt(String(form.get(name) ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${name}`);
  return n;
}

/* ── Auth ── */

export async function login(_prev: string | null, form: FormData): Promise<string | null> {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return "ยังไม่ได้ตั้ง DASHBOARD_PASSWORD ใน .env";
  const given = String(form.get("password") ?? "");
  if ((await sessionToken(given)) !== (await sessionToken(expected))) return "รหัสผ่านไม่ถูกต้อง";
  const store = await cookies();
  store.set(SESSION_COOKIE, await sessionToken(expected), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.DASHBOARD_SECURE_COOKIE === "true",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect("/");
}

export async function logout() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/login");
}

/* ── Action Center ── */

export async function resolveAlert(form: FormData) {
  await requireSession();
  const id = intField(form, "id");
  await exec(sql`UPDATE alerts SET resolved_at = now() WHERE id = ${id} AND resolved_at IS NULL`);
  revalidatePath("/", "layout");
}

export async function setProductBlacklist(form: FormData) {
  await requireSession();
  const id = intField(form, "id");
  const on = form.get("on") === "true";
  const reason = on ? String(form.get("reason") ?? "blacklisted from dashboard").slice(0, 200) : null;
  await exec(sql`
    UPDATE products SET flag_blacklisted = ${on}, flag_reason = ${reason} WHERE id = ${id}
  `);
  revalidatePath("/", "layout");
}

export async function deactivateVariant(form: FormData) {
  await requireSession();
  const id = intField(form, "id");
  await exec(sql`UPDATE content_variants SET is_active = false WHERE id = ${id}`);
  revalidatePath("/", "layout");
}
