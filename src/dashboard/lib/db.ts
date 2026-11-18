import "server-only";
import { type SQL } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// One pooled client per server process (survives Next.js dev hot reloads).
// Created lazily so `next build` doesn't need DATABASE_URL.
const globalForDb = globalThis as unknown as { __dashDb?: PostgresJsDatabase };

export function getDb(): PostgresJsDatabase {
  if (!globalForDb.__dashDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.__dashDb = drizzle(postgres(url, { max: 5, idle_timeout: 30 }));
  }
  return globalForDb.__dashDb;
}

/** Run a raw drizzle `sql` query and return typed rows. */
export async function rows<T>(query: SQL): Promise<T[]> {
  return (await getDb().execute(query)) as unknown as T[];
}

export async function one<T>(query: SQL): Promise<T | undefined> {
  return (await rows<T>(query))[0];
}

export async function exec(query: SQL): Promise<void> {
  await getDb().execute(query);
}
