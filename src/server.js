const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { loadConfig, assertProductionConfig } = require('./config');
const { createPool, migrate } = require('./db');
const { authRoutes, requireAuth } = require('./routes/auth');
const { productRoutes } = require('./routes/products');
const { queueRoutes } = require('./routes/queue');
const { earningsRoutes } = require('./routes/earnings');
const { connectionRoutes } = require('./routes/connections');
const { mediaRoutes, imageRoutes } = require('./routes/media');
const { cronRoutes } = require('./routes/cron');
const { garimpoRoutes } = require('./routes/garimpo');
const { automationRoutes } = require('./routes/automations');
const { couponRoutes } = require('./routes/coupons');
const { linkListRoutes } = require('./routes/linklists');
const { vitrineRoutes, publicVitrineRoutes } = require('./routes/vitrine');
const { directRoutes } = require('./routes/dm');
const { createStorage } = require('./services/storage');
const { startScheduler } = require('./services/publisher');

function createApp({ pool, cfg, fetchImpl = fetch, storage = createStorage(cfg) }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' https: data:; media-src 'self' https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self' https://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }));
  app.use(cookieParser());

  // Proteção básica contra CSRF: pedidos que alteram dados só valem se a origem for este mesmo servidor.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch (_) { host = ''; }
      if (host !== req.headers.host) return res.status(403).json({ error: 'Origem não permitida.' });
    }
    next();
  });

  app.get('/api/health', async (_req, res) => {
    try { await pool.query('select 1'); res.json({ ok: true }); }
    catch (_) { res.status(503).json({ ok: false }); }
  });

  app.use('/api/cron', cronRoutes({ pool, cfg, fetchImpl }));
  app.use('/api/img', imageRoutes({ cfg, fetchImpl })); // público: o Instagram baixa as fotos ajustadas daqui
  // Link curto do Garimpo: conta o clique e leva ao link de afiliado
  app.get('/r/:code', async (req, res) => {
    const target = await require('./services/links').resolveLink(pool, req.params.code, req.headers['user-agent']);
    if (!target) return res.status(404).send('Link não encontrado.');
    res.set('cache-control', 'no-store');
    res.redirect(302, target);
  });
  app.use('/v', publicVitrineRoutes({ pool, cfg })); // vitrine pública (mini site da bio) e páginas de post
  app.use('/api/auth', authRoutes({ pool, cfg }));
  const guard = requireAuth(cfg);
  app.use('/api/products', guard, productRoutes({ pool, cfg, fetchImpl }));
  app.use('/api/garimpo', guard, garimpoRoutes({ pool, cfg, fetchImpl }));
  app.use('/api/queue', guard, queueRoutes({ pool, cfg, fetchImpl, storage }));
  app.use('/api/media', guard, mediaRoutes({ cfg, storage, fetchImpl }));
  app.use('/api/earnings', guard, earningsRoutes({ pool, cfg }));
  app.use('/api/coupons', guard, couponRoutes({ pool, cfg, fetchImpl }));
  app.use('/api/link-lists', guard, linkListRoutes({ pool }));
  app.use('/api/vitrine', guard, vitrineRoutes({ pool, cfg }));
  app.use('/api/direct', guard, directRoutes({ pool, cfg, fetchImpl }));
  app.use('/api/automations', guard, automationRoutes({ pool, cfg, fetchImpl }));
  app.use('/api/connections', guard, connectionRoutes({ pool, cfg, fetchImpl }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

  app.use('/uploads', express.static(cfg.uploadDir, { index: false, maxAge: '7d' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Arquivo ou conteúdo grande demais.' });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    // Erros previstos (HttpError, com status) têm mensagem para o usuário, inclusive 502 com o motivo da Meta/loja.
    // Erros inesperados (sem status) ficam genéricos para não vazar detalhes internos.
    res.status(status).json({ error: err.status ? err.message : 'Erro interno do servidor.' });
  });

  return app;
}

async function main() {
  const cfg = loadConfig();
  if (cfg.prod) assertProductionConfig(cfg);
  else {
    if (!cfg.databaseUrl) throw new Error('Defina DATABASE_URL (veja .env.example).');
    cfg.jwtSecret = cfg.jwtSecret || 'dev-only-jwt-secret-change-me-0123456789';
    cfg.encryptionKey = cfg.encryptionKey || 'dev-only-encryption-key-change-me-0123';
  }
  const pool = createPool(cfg.databaseUrl, { max: cfg.dbPoolMax, caPem: cfg.dbSslCa });
  const applied = await migrate(pool);
  if (applied.length) console.log('Migrações aplicadas:', applied.join(', '));
  const app = createApp({ pool, cfg });
  startScheduler({ pool, cfg, fetchImpl: fetch });
  app.listen(cfg.port, () => console.log(`Garimpo rodando em ${cfg.appUrl} (porta ${cfg.port})`));
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { createApp };
