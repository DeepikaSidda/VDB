/**
 * Sets up a sample "legacy store" source database in the public schema of the
 * RDS instance, so the "Import existing database" flow has a real schema +
 * data to analyze and migrate. Idempotent: drops and recreates the tables.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const root = new URL('..', import.meta.url);
const env = {};
for (const line of readFileSync(new URL('web/.env.local', root), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const client = new pg.Client({
  host: env.AIDA_DB_HOST, port: Number(env.AIDA_DB_PORT ?? 5432), database: env.AIDA_DB_NAME,
  user: env.AIDA_DB_USER, password: env.AIDA_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query('SET search_path TO public');
  // Clean slate.
  await client.query(`DROP TABLE IF EXISTS order_items, orders, products, customers CASCADE`);

  await client.query(`
    CREATE TABLE customers (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      email     TEXT UNIQUE,
      city      TEXT,
      joined_on DATE
    )`);
  await client.query(`
    CREATE TABLE products (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL,
      price  NUMERIC(10,2),
      stock  INTEGER
    )`);
  await client.query(`
    CREATE TABLE orders (
      id          SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_date  DATE,
      total       NUMERIC(10,2)
    )`);
  await client.query(`
    CREATE TABLE order_items (
      id         SERIAL PRIMARY KEY,
      order_id   INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity   INTEGER NOT NULL
    )`);

  // Seed data.
  await client.query(`
    INSERT INTO customers (name, email, city, joined_on) VALUES
      ('Acme Corp', 'billing@acme.com', 'New York', '2023-01-15'),
      ('Globex',    'ap@globex.com',    'Chicago',  '2023-03-02'),
      ('Initech',   'finance@initech.com','Austin', '2023-06-20')`);
  await client.query(`
    INSERT INTO products (name, price, stock) VALUES
      ('Widget',   9.99,  500),
      ('Gadget',   19.50, 120),
      ('Sprocket', 4.25,  900),
      ('Cog',      2.10,  1500)`);
  await client.query(`
    INSERT INTO orders (customer_id, order_date, total) VALUES
      (1, '2024-02-01', 139.40),
      (1, '2024-02-06', 21.25),
      (2, '2024-02-03', 674.25),
      (3, '2024-02-05', 39.00)`);
  await client.query(`
    INSERT INTO order_items (order_id, product_id, quantity) VALUES
      (1, 1, 10), (1, 2, 4),
      (2, 3, 5),
      (3, 1, 25), (3, 3, 100),
      (4, 2, 2)`);

  const counts = {};
  for (const t of ['customers', 'products', 'orders', 'order_items']) {
    const r = await client.query(`SELECT count(*)::int n FROM public."${t}"`);
    counts[t] = r.rows[0].n;
  }
  console.log('Source "legacy store" created in public schema:', JSON.stringify(counts));
  console.log(`\nImport form values:`);
  console.log(`  Engine:   PostgreSQL`);
  console.log(`  Host:     ${env.AIDA_DB_HOST}`);
  console.log(`  Port:     ${env.AIDA_DB_PORT ?? 5432}`);
  console.log(`  Database: ${env.AIDA_DB_NAME}`);
  console.log(`  User:     ${env.AIDA_DB_USER}`);
  console.log(`  Password: (your AIDA_DB_PASSWORD)`);
} finally {
  await client.end();
}
