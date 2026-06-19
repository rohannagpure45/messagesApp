/**
 * Loads ./.env into process.env before anything else reads it.
 *
 * `tsx` and `node` do NOT auto-load .env (verified), and spectrum-ts only reads
 * `process.env` — it never loads a file. Importing this module first (see the top
 * of index.ts) guarantees credentials are present before Spectrum() / getConfig().
 *
 * Fail-soft: terminal-only dev needs no secrets, and real environments (CI, shell
 * exports) set vars directly — so a missing .env is not an error.
 */
try {
  process.loadEnvFile();
} catch {
  // No ./.env file (or unreadable) — rely on the ambient environment.
}
