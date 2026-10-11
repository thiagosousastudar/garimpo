const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');
const { migrate } = require('../src/db');
const { createApp } = require('../src/server');
const { loadConfig } = require('../src/config');
const { startScheduler } = require('../src/services/publisher');
const { parseCsv, parseNum, parseDate } = require('../src/util');
const { createStorage } = require('../src/services/storage');

const TOKEN = 'EAAB-super-secret-token-1234567890';

function makeMockFetch(log, { failMedia = false, videoStates = [] } = {}) {
  return async (url, opts = {}) => {
    const u = new URL(String(url));
    const body = opts.body instanceof URLSearchParams ? Object.fromEntries(opts.body) : null;
    log.push({ method: opts.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body });
    const json = (status, data) => ({ ok: status < 400, status, json: async () => data });
    if (u.hostname === 'graph.facebook.com') {
      if (u.pathname.endsWith('/media_publish')) return json(200, { id: 'MEDIA_1' });
      if (u.pathname.endsWith('/media')) {
        if (failMedia) return json(400, { error: { message: `Invalid token ${body.access_token}` } });
        return json(200, { id: 'CONTAINER_1' });
      }
      if (u.pathname.endsWith('/MEDIA_1')) return json(200, { permalink: 'https://instagram.com/p/abc' });
      if (u.pathname.endsWith('/CONTAINER_1')) return json(200, { status_code: videoStates.length ? videoStates.shift() : 'FINISHED' });
      return json(200, { username: 'loja_teste' });
    }
    if (u.hostname === 'api.anthropic.com') {
      return json(200, { content: [{ type: 'text', text: 'Legenda gerada pela IA' }] });
    }
    return json(404, {});
  };
}

async function boot(overrides = {}, mockOpts, extra = {}) {
  // Com PGURL definido, roda contra um Postgres de verdade; sem ele, usa o banco simulado em memória.
  let pool;
  if (process.env.PGURL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.PGURL });
    await pool.query('drop schema if exists public cascade');
    await pool.query('create schema public');
  } else {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    pool = new Pool();
  }
  // O banco simulado (pg-mem) não entende RLS; o Postgres real (PGURL) aplica tudo.
  await migrate(pool, undefined, { skip: process.env.PGURL ? undefined : (stmt) => /row level security/i.test(stmt) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garimpo-'));
  const cfg = {
    ...loadConfig({}),
    jwtSecret: 'x'.repeat(40),
    encryptionKey: 'y'.repeat(40),
    appUrl: 'https://app.exemplo.com',
    uploadDir: dir,
    videoPollMs: 1,
    ...overrides,
  };
  const calls = [];
  const fetchImpl = makeMockFetch(calls, mockOpts);
  const storage = extra.supabase ? createStorage(cfg, { createClient: extra.supabase }) : undefined;
  const app = createApp({ pool, cfg, fetchImpl, storage });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    return async function call(method, url, body, headers = {}) {
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      let payload;
      if (body instanceof FormData) payload = body;
      else if (typeof body === 'string') { h['content-type'] = 'text/csv'; payload = body; }
      else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(base + url, { method, headers: h, body: payload });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    };
  }
  return { pool, cfg, calls, fetchImpl, server, client, close: () => { server.closeAllConnections(); server.close(); pool.end().catch(() => {}); } };
}

async function signup(api, email = 'a@exemplo.com') {
  const r = await api('POST', '/api/auth/register', { email, password: 'senha-forte-1', name: 'Ana' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
}

const PRODUTO = {
  title: 'Air Fryer 3,5L', marketplace: 'ML', category: 'Casa e cozinha', price: '189,90',
  original_price: 329.9, rating: 4.8, sales_k: 12.4, commission_pct: 9,
  affiliate_url: 'https://mercadolivre.com/sec/abc', image_url: 'https://img.exemplo.com/a.jpg',
};

test('utilitários: números, datas e CSV', () => {
  assert.equal(parseNum('R$ 1.234,56'), 1234.56);
  assert.equal(parseNum('12.5'), 12.5);
  assert.equal(parseNum(''), null);
  assert.equal(parseDate('31/01/2026'), '2026-01-31');
  assert.equal(parseDate('31/02/2026'), null);
  const rows = parseCsv('titulo;preco\n"Kit; 3 peças";"84,00"\n');
  assert.deepEqual(rows, [{ titulo: 'Kit; 3 peças', preco: '84,00' }]);
});

test('autenticação: cadastro, sessão, login errado, rota protegida', async () => {
  const t = await boot();
  const api = t.client();
  assert.equal((await api('GET', '/api/products')).status, 401);
  await signup(api);
  const me = await api('GET', '/api/auth/me');
  assert.equal(me.data.user.email, 'a@exemplo.com');
  assert.equal((await api('POST', '/api/auth/register', { email: 'a@exemplo.com', password: 'outrasenha1' })).status, 409);
  assert.equal((await api('POST', '/api/auth/register', { email: 'x@y.com', password: 'curta' })).status, 400);
  const other = t.client();
  assert.equal((await other('POST', '/api/auth/login', { email: 'a@exemplo.com', password: 'errada-errada' })).status, 401);
  assert.equal((await other('POST', '/api/auth/login', { email: 'a@exemplo.com', password: 'senha-forte-1' })).status, 200);
  const hash = (await t.pool.query('select password_hash from users')).rows[0].password_hash;
  assert.notEqual(hash, 'senha-forte-1');
  t.close();
});

test('proteção de origem (CSRF)', async () => {
  const t = await boot();
  const api = t.client();
  const r = await api('POST', '/api/auth/register', { email: 'a@exemplo.com', password: 'senha-forte-1' }, { origin: 'https://site-malicioso.com' });
  assert.equal(r.status, 403);
  t.close();
});

test('produtos: CRUD, nota de prioridade, validação e isolamento entre contas', async () => {
  const t = await boot();
  const a = t.client();
  const b = t.client();
  await signup(a, 'a@exemplo.com');
  await signup(b, 'b@exemplo.com');

  const bad = await a('POST', '/api/products', { ...PRODUTO, marketplace: 'AMAZON' });
  assert.equal(bad.status, 400);
  assert.equal((await a('POST', '/api/products', { ...PRODUTO, price: 0 })).status, 400);
  assert.equal((await a('POST', '/api/products', { ...PRODUTO, image_url: 'javascript:alert(1)' })).status, 400);

  const created = await a('POST', '/api/products', PRODUTO);
  assert.equal(created.status, 201);
  const p = created.data.product;
  assert.equal(p.price, 189.9);
  assert.equal(p.desc, 42);
  assert.equal(p.earn_per_sale, 17.09);
  assert.ok(p.score > 0 && p.score <= 100);

  await a('POST', '/api/products', { title: 'Item fraco', marketplace: 'SH', price: 10 });
  const list = await a('GET', '/api/products');
  assert.equal(list.data.products.length, 2);
  assert.equal(list.data.products[0].title, 'Air Fryer 3,5L'); // maior nota primeiro

  assert.equal((await b('GET', '/api/products')).data.products.length, 0);
  assert.equal((await b('PATCH', `/api/products/${p.id}`, { price: 1 })).status, 404);
  assert.equal((await b('DELETE', `/api/products/${p.id}`)).status, 404);

  const upd = await a('PATCH', `/api/products/${p.id}`, { price: 150 });
  assert.equal(upd.data.product.price, 150);
  assert.equal((await a('DELETE', `/api/products/${p.id}`)).status, 200);
  t.close();
});

test('produtos: importação de CSV com vírgula decimal e erros por linha', async () => {
  const t = await boot();
  const a = t.client();
  await signup(a);
  const csv = [
    'titulo;marketplace;categoria;preco;preco_original;avaliacao;vendas_mil;comissao;link_afiliado',
    'Mochila;ML;Acessórios;"69,19";"119,00";4,6;5,6;11;https://exemplo.com/x',
    'Sem preço;SH;Beleza;;;;;;',
    'Loja errada;AMZ;Beleza;10;;;;;',
  ].join('\n');
  const r = await a('POST', '/api/products/import', csv);
  assert.equal(r.data.imported, 1);
  assert.equal(r.data.errors.length, 2);
  assert.equal(r.data.errors[0].line, 3);
  const list = await a('GET', '/api/products');
  assert.equal(list.data.products[0].price, 69.19);
  assert.equal(list.data.products[0].rating, 4.6);
  t.close();
});

test('fila: textos, edição, agendamento, mídia e regras de status', async () => {
  const t = await boot();
  const a = t.client();
  await signup(a);
  const p = (await a('POST', '/api/products', PRODUTO)).data.product;

  const ig = await a('POST', '/api/queue', { product_id: p.id, channel: 'instagram' });
  assert.equal(ig.status, 201);
  assert.match(ig.data.item.caption, /Air Fryer 3,5L/);
  assert.match(ig.data.item.caption, /Link na bio/);
  assert.equal(ig.data.item.media_type, 'image');

  const zap = await a('POST', '/api/queue', { product_id: p.id, channel: 'whatsapp' });
  assert.match(zap.data.item.caption, /mercadolivre\.com\/sec\/abc/);

  const semLink = (await a('POST', '/api/products', { title: 'Sem link', marketplace: 'SH', price: 20 })).data.product;
  const z2 = await a('POST', '/api/queue', { product_id: semLink.id, channel: 'whatsapp' });
  assert.match(z2.data.item.caption, /\[SEU LINK DE AFILIADO\]/);

  assert.equal((await a('POST', '/api/queue', { product_id: p.id, channel: 'tiktok' })).status, 400);
  assert.equal((await a('POST', '/api/queue', { product_id: 99999, channel: 'instagram' })).status, 404);

  const when = new Date(Date.now() + 3600e3).toISOString();
  const sched = await a('PATCH', `/api/queue/${ig.data.item.id}`, { scheduled_at: when, caption: 'Texto editado' });
  assert.equal(sched.data.item.status, 'scheduled');
  assert.equal(sched.data.item.caption, 'Texto editado');
  const unsched = await a('PATCH', `/api/queue/${ig.data.item.id}`, { scheduled_at: null });
  assert.equal(unsched.data.item.status, 'draft');

  const done = await a('POST', `/api/queue/${zap.data.item.id}/mark-posted`);
  assert.equal(done.data.item.status, 'posted');
  assert.equal((await a('PATCH', `/api/queue/${zap.data.item.id}`, { caption: 'x' })).status, 409);
  assert.equal((await a('POST', `/api/queue/${zap.data.item.id}/reopen`)).data.item.status, 'draft');

  const ai = await a('POST', `/api/queue/${ig.data.item.id}/regenerate`, { ai: true });
  assert.match(ai.data.warning, /ANTHROPIC_API_KEY/);
  t.close();
});

test('fila: legenda com IA quando a chave está configurada', async () => {
  const t = await boot({ anthropicKey: 'sk-test' });
  const a = t.client();
  await signup(a);
  const p = (await a('POST', '/api/products', PRODUTO)).data.product;
  const r = await a('POST', '/api/queue', { product_id: p.id, channel: 'instagram', ai: true });
  assert.equal(r.data.item.caption, 'Legenda gerada pela IA');
  t.close();
});

test('Instagram: conexão criptografada, publicação de foto e erro sem vazar o token', async () => {
  const t = await boot();
  const a = t.client();
  await signup(a);

  assert.equal((await a('PUT', '/api/connections/instagram', { ig_user_id: 'abc', access_token: TOKEN })).status, 400);
  const conn = await a('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000', access_token: TOKEN });
  assert.equal(conn.status, 200);
  assert.equal(conn.data.username, 'loja_teste');
  const stored = (await t.pool.query('select ig_token_enc from connections')).rows[0].ig_token_enc;
  assert.ok(!stored.includes(TOKEN), 'token não pode ficar em texto puro no banco');

  const p = (await a('POST', '/api/products', PRODUTO)).data.product;
  const item = (await a('POST', '/api/queue', { product_id: p.id, channel: 'instagram' })).data.item;
  const pub = await a('POST', `/api/queue/${item.id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.data.item.status, 'posted');
  assert.equal(pub.data.item.external_id, 'MEDIA_1');
  assert.equal(pub.data.item.permalink, 'https://instagram.com/p/abc');

  const create = t.calls.find((c) => c.path.endsWith('/media') && c.method === 'POST');
  assert.equal(create.body.image_url, PRODUTO.image_url);
  assert.equal(create.body.access_token, TOKEN);

  const again = await a('POST', `/api/queue/${item.id}/publish`);
  assert.equal(again.status, 409);
  t.close();
});

test('Instagram: validações antes de publicar e falha da Meta registrada sem token', async () => {
  const local = await boot({ appUrl: 'http://localhost:3000' });
  const a = local.client();
  await signup(a);
  await a('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000', access_token: TOKEN });
  const p = (await a('POST', '/api/products', { ...PRODUTO, image_url: '' })).data.product;
  const noMedia = (await a('POST', '/api/queue', { product_id: p.id, channel: 'instagram' })).data.item;
  const r1 = await a('POST', `/api/queue/${noMedia.id}/publish`);
  assert.equal(r1.status, 400);
  assert.match(r1.data.error, /foto ou um vídeo/);
  const png = await a('PATCH', `/api/queue/${noMedia.id}`, { media_type: 'image', media_url: '/uploads/x.jpg' });
  assert.equal(png.status, 200);
  const r2 = await a('POST', `/api/queue/${noMedia.id}/publish`);
  assert.match(r2.data.error, /URL pública/);
  const listed = (await a('GET', '/api/queue')).data.items[0];
  assert.equal(listed.status, 'failed');
  assert.match(listed.error, /URL pública/);
  local.close();

  const t = await boot({}, { failMedia: true });
  const b = t.client();
  await signup(b);
  await b('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000', access_token: TOKEN });
  const p2 = (await b('POST', '/api/products', PRODUTO)).data.product;
  const it = (await b('POST', '/api/queue', { product_id: p2.id, channel: 'instagram' })).data.item;
  const r3 = await b('POST', `/api/queue/${it.id}/publish`);
  assert.equal(r3.status, 502);
  assert.ok(!JSON.stringify(r3.data).includes(TOKEN), 'resposta não pode conter o token');
  const row = (await t.pool.query('select error, status from queue_items')).rows[0];
  assert.equal(row.status, 'failed');
  assert.ok(!row.error.includes(TOKEN), 'erro salvo não pode conter o token');
  t.close();
});

test('Instagram: Reels aguarda o processamento do vídeo', async () => {
  const t = await boot();
  const a = t.client();
  await signup(a);
  await a('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000', access_token: TOKEN });
  const p = (await a('POST', '/api/products', { ...PRODUTO, image_url: '', video_url: 'https://cdn.exemplo.com/v.mp4' })).data.product;
  const it = (await a('POST', '/api/queue', { product_id: p.id, channel: 'instagram' })).data.item;
  assert.equal(it.media_type, 'video');
  const r = await a('POST', `/api/queue/${it.id}/publish`);
  assert.equal(r.data.item.status, 'posted');
  const create = t.calls.find((c) => c.path.endsWith('/media') && c.method === 'POST');
  assert.equal(create.body.media_type, 'REELS');
  assert.equal(create.body.video_url, 'https://cdn.exemplo.com/v.mp4');
  assert.ok(t.calls.some((c) => c.path.endsWith('/CONTAINER_1') && c.method === 'GET'));
  t.close();
});

test('agendador publica itens vencidos e ignora os futuros', async () => {
  const t = await boot();
  const a = t.client();
  await signup(a);
  await a('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000', access_token: TOKEN });
  const p = (await a('POST', '/api/products', PRODUTO)).data.product;
  const due = (await a('POST', '/api/queue', { product_id: p.id, channel: 'instagram' })).data.item;
  const future = (await a('POST', '/api/queue', { product_id: p.id, channel: 'instagram' })).data.item;
  await a('PATCH', `/api/queue/${due.id}`, { scheduled_at: new Date(Date.now() + 500).toISOString() });
  await a('PATCH', `/api/queue/${future.id}`, { scheduled_at: new Date(Date.now() + 3600e3).toISOString() });
  await new Promise((r) => setTimeout(r, 700));
  const sch = startScheduler({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl, log: { log() {}, error() {} } });
  await sch.tick();
  sch.stop();
  const rows = (await t.pool.query('select id, status from queue_items order by id')).rows;
  assert.equal(rows.find((r) => r.id === due.id).status, 'posted');
  assert.equal(rows.find((r) => r.id === future.id).status, 'scheduled');
  t.close();
});

test('upload: aceita JPEG pelo conteúdo e recusa arquivo disfarçado', async () => {
  const t = await boot();
  const a = t.client();
  await signup(a);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
  const fd = new FormData();
  fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'foto.jpg');
  const ok = await a('POST', '/api/queue/upload', fd);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.match(ok.data.url, /^\/uploads\/[0-9a-f]{32}\.jpg$/);
  const served = await fetch(`http://127.0.0.1:${t.server.address().port}${ok.data.url}`);
  assert.equal(served.status, 200);

  const fd2 = new FormData();
  fd2.append('file', new Blob(['<script>alert(1)</script>'], { type: 'image/jpeg' }), 'x.jpg');
  const bad = await a('POST', '/api/queue/upload', fd2);
  assert.equal(bad.status, 400);
  t.close();
});

test('ganhos: lançamentos, importação, resumo e isolamento', async () => {
  const t = await boot();
  const a = t.client();
  const b = t.client();
  await signup(a, 'a@exemplo.com');
  await signup(b, 'b@exemplo.com');
  const p = (await a('POST', '/api/products', PRODUTO)).data.product;

  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  assert.equal((await a('POST', '/api/earnings', { day: 'ontem', channel: 'instagram', commission: 10 })).status, 400);
  assert.equal((await a('POST', '/api/earnings', { day: hoje, channel: 'instagram', commission: -1 })).status, 400);
  assert.equal((await a('POST', '/api/earnings', { day: hoje, channel: 'instagram', commission: 10, product_id: 9999 })).status, 404);

  await a('POST', '/api/earnings', { day: hoje, channel: 'instagram', clicks: 100, orders: 5, commission: '102,55', status: 'pendente', product_id: p.id });
  await a('POST', '/api/earnings', { day: hoje, channel: 'whatsapp', clicks: 50, orders: 2, commission: 20, status: 'paga' });
  const csv = `data;produto;canal;cliques;pedidos;comissao;situacao\n${hoje.split('-').reverse().join('/')};Air Fryer 3,5L;instagram;10;1;7,45;confirmada\n01/01/1999;;instagram;1;1;5;paga\nxx;;instagram;1;1;5;paga`;
  const imp = await a('POST', '/api/earnings/import', csv);
  assert.equal(imp.data.imported, 2);
  assert.equal(imp.data.errors.length, 1);

  const s = (await a('GET', '/api/earnings/summary?days=14')).data;
  assert.equal(s.by_day.length, 14);
  assert.equal(s.kpis.clicks, 160);
  assert.equal(s.kpis.orders, 8);
  assert.equal(s.kpis.pending, 102.55);
  assert.equal(s.kpis.confirmed, 7.45);
  assert.equal(s.kpis.paid, 20);
  assert.equal(s.kpis.to_receive, 110);
  assert.equal(s.kpis.total, 130);
  assert.equal(s.kpis.conversion, 5);
  assert.equal(s.by_channel[0].channel, 'instagram');
  assert.equal(s.by_product[0].title, 'Air Fryer 3,5L');
  assert.equal(s.by_product[0].commission, 110);
  assert.equal(s.by_day[13].commission, 130);

  const sb = (await b('GET', '/api/earnings/summary')).data;
  assert.equal(sb.kpis.total, 0);
  t.close();
});

test('migrações são idempotentes', async () => {
  const t = await boot();
  assert.deepEqual(await migrate(t.pool), []);
  t.close();
});

async function conectarInstagram(api) {
  const r = await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000', access_token: TOKEN });
  assert.equal(r.status, 200);
}

test('Reels: fica em processamento e a chamada do agendador conclui depois', async () => {
  const t = await boot({ videoInlinePolls: 2, cronSecret: 'segredo-cron-1234' }, { videoStates: ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'] });
  const a = t.client();
  await signup(a);
  await conectarInstagram(a);
  const p = (await a('POST', '/api/products', { ...PRODUTO, image_url: '', video_url: 'https://cdn.exemplo.com/v.mp4' })).data.product;
  const it = (await a('POST', '/api/queue', { product_id: p.id, channel: 'instagram' })).data.item;

  const pub = await a('POST', `/api/queue/${it.id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.data.item.status, 'processing');
  assert.equal(pub.data.item.container_id, 'CONTAINER_1');
  assert.equal(t.calls.filter((c) => c.path.endsWith('/media_publish')).length, 0, 'ainda não publicou');

  assert.equal((await a('GET', '/api/cron/tick')).status, 401);
  assert.equal((await a('GET', '/api/cron/tick', undefined, { authorization: 'Bearer errado' })).status, 401);
  const tick = await a('GET', '/api/cron/tick', undefined, { authorization: 'Bearer segredo-cron-1234' });
  assert.equal(tick.status, 200, JSON.stringify(tick.data));
  assert.equal(tick.data.finished, 1);
  const row = (await t.pool.query('select status, external_id from queue_items')).rows[0];
  assert.equal(row.status, 'posted');
  assert.equal(row.external_id, 'MEDIA_1');

  const again = await a('POST', '/api/cron/tick', undefined, { authorization: 'Bearer segredo-cron-1234' });
  assert.equal(again.data.finished, 0);
  assert.equal(t.calls.filter((c) => c.path.endsWith('/media_publish')).length, 1, 'não publica em duplicidade');
  t.close();
});

test('cron desativado sem CRON_SECRET', async () => {
  const t = await boot();
  const r = await t.client()('GET', '/api/cron/tick', undefined, { authorization: 'Bearer qualquer' });
  assert.equal(r.status, 503);
  t.close();
});

test('Reels: botão Verificar conclui ou registra falha do Instagram', async () => {
  const t = await boot({ videoInlinePolls: 1 }, { videoStates: ['IN_PROGRESS'] });
  const a = t.client();
  await signup(a);
  await conectarInstagram(a);
  const p = (await a('POST', '/api/products', { ...PRODUTO, image_url: '', video_url: 'https://cdn.exemplo.com/v.mp4' })).data.product;
  const it = (await a('POST', '/api/queue', { product_id: p.id, channel: 'instagram' })).data.item;
  assert.equal((await a('POST', `/api/queue/${it.id}/publish`)).data.item.status, 'processing');
  const chk = await a('POST', `/api/queue/${it.id}/check`);
  assert.equal(chk.data.item.status, 'posted');
  t.close();

  const t2 = await boot({ videoInlinePolls: 1 }, { videoStates: ['IN_PROGRESS', 'ERROR'] });
  const b = t2.client();
  await signup(b);
  await conectarInstagram(b);
  const p2 = (await b('POST', '/api/products', { ...PRODUTO, image_url: '', video_url: 'https://cdn.exemplo.com/v.mp4' })).data.product;
  const it2 = (await b('POST', '/api/queue', { product_id: p2.id, channel: 'instagram' })).data.item;
  await b('POST', `/api/queue/${it2.id}/publish`);
  const chk2 = await b('POST', `/api/queue/${it2.id}/check`);
  assert.equal(chk2.data.item.status, 'failed');
  assert.match(chk2.data.item.error, /não conseguiu processar/);
  t2.close();
});

test('agendador limpa itens presos em publicação', async () => {
  const t = await boot();
  const a = t.client();
  await signup(a);
  const p = (await a('POST', '/api/products', PRODUTO)).data.product;
  const it = (await a('POST', '/api/queue', { product_id: p.id, channel: 'instagram' })).data.item;
  await t.pool.query(`update queue_items set status = 'publishing', claimed_at = now() - interval '20 minutes' where id = $1`, [it.id]);
  const sch = startScheduler({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl, log: { log() {}, error() {} } });
  const r = await sch.tick();
  sch.stop();
  assert.equal(r.released, 1);
  assert.equal((await t.pool.query('select status from queue_items')).rows[0].status, 'failed');
  t.close();
});

test('mídia: modo local devolve driver local', async () => {
  const t = await boot();
  const a = t.client();
  assert.equal((await a('POST', '/api/media/sign', { content_type: 'image/jpeg' })).status, 401);
  await signup(a);
  assert.deepEqual((await a('POST', '/api/media/sign', { content_type: 'image/jpeg', size: 1000 })).data, { driver: 'local' });
  assert.equal((await a('POST', '/api/media/sign', { content_type: 'text/html' })).status, 400);
  t.close();
});

test('mídia: modo Supabase entrega URL assinada e bloqueia o envio pelo servidor', async () => {
  const signed = [];
  const fakeCreateClient = (url, key) => {
    assert.equal(url, 'https://abc.supabase.co');
    assert.equal(key, 'service-key');
    return { storage: { from: (bucket) => ({ createSignedUploadUrl: async (path) => { signed.push({ bucket, path }); return { data: { token: 'tok-123', path, signedUrl: 'x' }, error: null }; } }) } };
  };
  const t = await boot(
    { supabaseUrl: 'https://abc.supabase.co', supabaseServiceKey: 'service-key', supabaseAnonKey: 'anon-key' },
    undefined,
    { supabase: fakeCreateClient }
  );
  const a = t.client();
  await signup(a);
  const r = await a('POST', '/api/media/sign', { content_type: 'video/mp4', size: 5e6 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.driver, 'supabase');
  assert.equal(r.data.token, 'tok-123');
  assert.equal(r.data.anon_key, 'anon-key');
  assert.equal(r.data.media_type, 'video');
  assert.match(r.data.public_url, /^https:\/\/abc\.supabase\.co\/storage\/v1\/object\/public\/midia\/\d+\/[0-9a-f]{32}\.mp4$/);
  assert.equal(signed[0].bucket, 'midia');
  assert.ok(!JSON.stringify(r.data).includes('service-key'), 'a chave de serviço não pode vazar');

  assert.equal((await a('POST', '/api/media/sign', { content_type: 'video/mp4', size: 200 * 1024 * 1024 })).status, 400);
  assert.equal((await a('POST', '/api/media/sign', { content_type: 'image/jpeg', size: 20 * 1024 * 1024 })).status, 400);

  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }), 'a.jpg');
  assert.equal((await a('POST', '/api/queue/upload', fd)).status, 400);
  t.close();
});

test('banco: RLS ligado nas tabelas do app (Supabase não expõe os dados pela API pública)', async () => {
  if (!process.env.PGURL) return; // pg-mem não expõe pg_class.relrowsecurity
  const t = await boot();
  const { rows } = await t.pool.query(
    `select relname from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace and not relrowsecurity order by 1`
  );
  assert.deepEqual(rows, []);
  t.close();
});
