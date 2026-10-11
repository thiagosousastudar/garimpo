// Aplica as migrações SQL no banco:  npm run migrate
// Use a conexão DIRETA do Supabase (porta 5432) em MIGRATE_DATABASE_URL; se faltar, usa DATABASE_URL.
const { createPool, migrate } = require('../src/db');

const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('Defina MIGRATE_DATABASE_URL ou DATABASE_URL.'); process.exit(1); }

const pool = createPool(url, { max: 1, caPem: process.env.DATABASE_SSL_CA || '' });
migrate(pool)
  .then((applied) => console.log(applied.length ? `Migrações aplicadas: ${applied.join(', ')}` : 'Banco já está atualizado.'))
  .catch((e) => { console.error('Falha na migração:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
