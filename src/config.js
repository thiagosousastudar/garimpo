const path = require('path');

function loadConfig(env = process.env) {
  const cfg = {
    port: Number(env.PORT) || 3000,
    databaseUrl: env.DATABASE_URL || '',
    jwtSecret: env.JWT_SECRET || '',
    encryptionKey: env.ENCRYPTION_KEY || '',
    appUrl: (env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
    uploadDir: env.UPLOAD_DIR || path.join(process.cwd(), 'data', 'uploads'),
    prod: env.NODE_ENV === 'production',
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    allowSignup: env.ALLOW_SIGNUP !== 'false',
    graphBase: (env.GRAPH_BASE || 'https://graph.facebook.com').replace(/\/$/, ''),
    graphVersion: env.GRAPH_VERSION || 'v21.0',
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    schedulerMs: Number(env.SCHEDULER_MS) || 60000,
    videoPollMs: env.VIDEO_POLL_MS !== undefined ? Number(env.VIDEO_POLL_MS) : 3000,
    videoInlinePolls: env.VIDEO_INLINE_POLLS !== undefined ? Number(env.VIDEO_INLINE_POLLS) : 5,
    cronSecret: env.CRON_SECRET || '',
    supabaseUrl: (env.SUPABASE_URL || '').replace(/\/$/, ''),
    supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    supabaseBucket: env.SUPABASE_BUCKET || 'midia',
    dbPoolMax: Number(env.DB_POOL_MAX) || (env.VERCEL ? 2 : 10),
    dbSslCa: env.DATABASE_SSL_CA || '',
  };
  return cfg;
}

function assertProductionConfig(cfg) {
  const problems = [];
  if (!cfg.databaseUrl) problems.push('DATABASE_URL é obrigatório');
  if (cfg.jwtSecret.length < 32) problems.push('JWT_SECRET precisa ter pelo menos 32 caracteres');
  if (cfg.encryptionKey.length < 32) problems.push('ENCRYPTION_KEY precisa ter pelo menos 32 caracteres');
  if (cfg.supabaseUrl && (!cfg.supabaseServiceKey || !cfg.supabaseAnonKey)) {
    problems.push('com SUPABASE_URL, defina também SUPABASE_SERVICE_ROLE_KEY e SUPABASE_ANON_KEY');
  }
  if (problems.length) throw new Error('Configuração inválida: ' + problems.join('; '));
}

module.exports = { loadConfig, assertProductionConfig };
