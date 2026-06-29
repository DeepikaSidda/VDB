/**
 * Manage the per-generation schemas (gen_*) that accumulate in the live
 * Aurora/RDS PostgreSQL database.
 *
 * Reads the connection from web/.env.local (AIDA_DB_*). SAFE BY DEFAULT: with
 * no flags it only LISTS the schemas and their row counts — it never drops
 * anything unless you pass an explicit drop flag together with --yes.
 *
 * Usage (run from the repo root):
 *   node scripts/cleanup-generations.mjs                 # list only (safe)
 *   node scripts/cleanup-generations.mjs --keep 3 --yes  # drop all but newest 3
 *   node scripts/cleanup-generations.mjs --drop-all --yes
 *   node scripts/cleanup-generations.mjs --drop gen_xxx --yes
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const root = new URL('..', import.meta.url);
const envText = readFileSync(new URL('web/.env.local', root), 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const confirmed = has('--yes');

const client = new pg.Client({
  host: env.AIDA_DB_HOST,
  port: Number(env.AIDA_DB_PORT ?? 5432),
  database: env.AIDA_DB_NAME,
  user: env.AIDA_DB_USER,
  password: env.AIDA_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  // Newest first (schema names embed a base36 timestamp, so name sort ≈ time sort).
  const { rows } = await client.query(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'gen_%' ORDER BY schema_name DESC`,
  );
  const schemas = rows.map((r) => r.schema_name);
  console.log(`database ${env.AIDA_DB_NAME}: ${schemas.length} generation schema(s)\n`);

  for (const schema of schemas) {
    const t = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    );
    console.log(`  ${schema}  (${t.rows[0].n} table(s))`);
  }

  // Decide which to drop.
  let toDrop = [];
  if (has('--drop-all')) {
    toDrop = schemas;
  } else if (valueOf('--drop')) {
    toDrop = schemas.filter((s) => s === valueOf('--drop'));
  } else if (valueOf('--keep') !== undefined) {
    const keep = Math.max(0, Number(valueOf('--keep')) || 0);
    toDrop = schemas.slice(keep); // newest `keep` are kept
  }

  if (toDrop.length === 0) {
    console.log('\nNothing to drop. (Use --drop-all, --drop <schema>, or --keep <n>, plus --yes.)');
    process.exit(0);
  }

  console.log(`\nWill drop ${toDrop.length} schema(s):`);
  for (const s of toDrop) console.log(`  - ${s}`);

  if (!confirmed) {
    console.log('\nDRY RUN — pass --yes to actually drop these schemas.');
    process.exit(0);
  }

  for (const s of toDrop) {
    await client.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    console.log(`dropped ${s}`);
  }
  console.log(`\nDone. Dropped ${toDrop.length} schema(s).`);
} finally {
  await client.end();
}
