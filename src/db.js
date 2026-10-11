const fs = require('fs');
const path = require('path');

function sslFor(databaseUrl, caPem) {
  let host = '';
  try { host = new URL(databaseUrl).hostname; } catch (_) { /* url inválida: o pg avisa depois */ }
  if (!host || ['localhost', '127.0.0.1', '::1', 'db', 'postgres'].includes(host)) return undefined;
  // Bancos gerenciados (Supabase etc.) exigem conexão criptografada. Com DATABASE_SSL_CA o certificado é verificado.
  return caPem ? { ca: caPem, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

function createPool(databaseUrl, { max = 10, caPem = '' } = {}) {
  const { Pool } = require('pg');
  return new Pool({
    connectionString: databaseUrl,
    ssl: sslFor(databaseUrl, caPem),
    max,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
}

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function migrate(pool, dir = path.join(__dirname, '..', 'migrations'), { skip } = {}) {
  try {
    await pool.query('select 1 from schema_migrations limit 1');
  } catch (_) {
    await pool.query('create table schema_migrations (name text primary key)');
  }
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    // Arquivos com blocos DO ($$) vão inteiros; os demais, um comando por vez.
    if (sql.includes('$$')) await pool.query(sql);
    else for (const stmt of splitStatements(sql)) { if (!skip || !skip(stmt)) await pool.query(stmt); }
    await pool.query('insert into schema_migrations (name) values ($1)', [file]);
    applied.push(file);
  }
  return applied;
}

module.exports = { createPool, migrate };
