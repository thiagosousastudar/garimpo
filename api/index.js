// Ponto de entrada da Vercel: exporta o app Express como função serverless.
const { loadConfig, assertProductionConfig } = require('../src/config');
const { createPool } = require('../src/db');
const { createApp } = require('../src/server');

const cfg = loadConfig();
assertProductionConfig(cfg);
const pool = createPool(cfg.databaseUrl, { max: cfg.dbPoolMax, caPem: cfg.dbSslCa });

module.exports = createApp({ pool, cfg });
