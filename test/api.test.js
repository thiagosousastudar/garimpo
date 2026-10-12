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

function makeMockFetch(log, { failMedia = false, videoStates = [], shopee = {}, ml = {} } = {}) {
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
    if (u.hostname === 'open-api.affiliate.shopee.com.br') {
      log[log.length - 1].headers = opts.headers;
      log[log.length - 1].gql = JSON.parse(opts.body).query;
      if (shopee.reject) return json(200, { errors: [{ message: 'Invalid Credential', extensions: { code: 10020 } }] });
      const node = (id, price) => ({
        itemId: id, shopId: 77, productName: `Fone Bluetooth ${id}`, price: String(price), priceMin: String(price),
        priceMax: String(price), priceDiscountRate: 40, commissionRate: '0.12', sales: 15300, ratingStar: '4.83',
        imageUrl: `https://cf.shopee.com.br/file/${id}`, productLink: `https://shopee.com.br/product/77/${id}`,
        offerLink: `https://s.shopee.com.br/af${id}`, shopName: 'Loja Som',
      });
      const isItem = /itemId:/.test(log[log.length - 1].gql);
      const nodes = isItem ? [node(1001, shopee.itemPrice || 59.9)] : [node(1001, 59.9), node(1002, 89.9)];
      return json(200, { data: { productOfferV2: { nodes, pageInfo: { page: 1, hasNextPage: !isItem } } } });
    }
    if (u.hostname === 'api.mercadolibre.com') {
      if (u.pathname === '/oauth/token') {
        ml.tokenCalls = (ml.tokenCalls || 0) + 1;
        if (ml.rejectToken) return json(400, { message: 'invalid_grant' });
        return json(200, { access_token: `APP_USR-token-${ml.tokenCalls}`, refresh_token: `TG-refresh-${ml.tokenCalls}`, expires_in: 21600 });
      }
      log[log.length - 1].auth = opts.headers?.authorization;
      const item = (id, price) => ({
        id, title: `Air Fryer ${id}`, price, original_price: 399.9, permalink: `https://produto.mercadolivre.com.br/${id.replace('MLB', 'MLB-')}-air-fryer`,
        thumbnail: `http://http2.mlstatic.com/D_${id}-I.jpg`, sold_quantity: 2500,
      });
      if (u.pathname === '/sites/MLB/search') {
        if (ml.search403) return json(403, { message: 'forbidden' });
        return json(200, { results: [item('MLB111', 249.9), item('MLB222', 199.9)], paging: { total: 2 } });
      }
      // Como na conta real: catálogo sem preço; preço pelos vendedores do produto; ranking de mais vendidos.
      if (u.pathname === '/products/search') {
        return json(200, { results: [
          { id: 'MLB9001', name: 'Air Fryer Catálogo', pictures: [{ url: 'https://http2.mlstatic.com/D_9001-F.jpg' }] },
          { id: 'MLB9002', name: 'Air Fryer Sem Vendedor', pictures: [] },
        ], paging: { total: 2 } });
      }
      if (u.pathname === '/products/MLB9001/items') {
        return json(200, { paging: { total: 2 }, results: [{ item_id: 'MLB5', category_id: 'MLB456045', price: ml.catalogPrice || 299.9, original_price: 399.9, official_store_id: 2707, warranty: 'Garantia de fábrica: 12 meses', shipping: { free_shipping: true, logistic_type: 'fulfillment' } }, { item_id: 'MLB6', price: 319.9, shipping: { free_shipping: false } }] });
      }
      if (u.pathname === '/products/MLB9002/items') return json(200, { results: [] });
      if (u.pathname === '/products/MLB9001') return json(200, { id: 'MLB9001', name: 'Air Fryer Catálogo', pictures: [{ url: 'https://http2.mlstatic.com/D_9001-F.jpg' }, { url: 'http://http2.mlstatic.com/D_9001b-F.jpg' }], main_features: [{ text: 'Capacidade de 4,2 L para porções individuais.' }, { text: 'Potência de 1400 W.' }], attributes: [{ id: 'BRAND', value_name: 'Elgin' }] });
      if (u.pathname.startsWith('/products/')) return json(404, { message: 'not found' });
      if (u.pathname === '/sites/MLB/domain_discovery/search') return json(200, [{ category_id: 'MLB456045' }]);
      if (u.pathname.startsWith('/highlights/MLB/category/')) return json(200, { content: [{ id: 'MLB9001', position: 3, type: 'PRODUCT' }, { id: 'MLB7777', position: 4, type: 'USER_PRODUCT' }] });
      if (u.pathname === '/trends/MLB' || u.pathname.startsWith('/trends/MLB/')) return json(200, [{ keyword: 'air fryer' }, { keyword: u.pathname.length > 11 ? 'trend da categoria' : 'fone bluetooth' }]);
      if (u.pathname === '/categories/MLB456045') return json(200, { id: 'MLB456045', path_from_root: [{ id: 'MLB5726', name: 'Eletrodomésticos' }, { id: 'MLB456045', name: 'De Ar' }] });
      if (u.pathname === '/sites/MLB/categories') return json(200, [{ id: 'MLB5726', name: 'Eletrodomésticos' }, { id: 'MLB1648', name: 'Informática' }]);
      if (u.pathname.startsWith('/items/')) return json(200, item(u.pathname.split('/')[2], ml.itemPrice || 229.9));
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
    const jar = new Map();
    return async function call(method, url, body, headers = {}) {
      const h = { ...headers };
      if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      let payload;
      if (body instanceof FormData) payload = body;
      else if (typeof body === 'string') { h['content-type'] = 'text/csv'; payload = body; }
      else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
      for (const set of res.headers.getSetCookie()) {
        const [pair, ...attrs] = set.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1);
        if (!value || attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a))) jar.delete(name); else jar.set(name, value);
      }
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data, location: res.headers.get('location') };
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

const { externalIdFrom } = require('../src/services/garimpo');

test('garimpo: código do produto tirado do link', () => {
  assert.equal(externalIdFrom('ML', 'https://produto.mercadolivre.com.br/MLB-1234567890-air-fryer-_JM'), 'MLB1234567890');
  assert.equal(externalIdFrom('ML', 'https://www.mercadolivre.com.br/air-fryer/p/MLB19876543?pdp_filters=item_id:MLB5551234567'), 'MLB19876543');
  assert.equal(externalIdFrom('ML', 'https://www.mercadolivre.com.br/air-fryer/p/MLB19876543'), 'MLB19876543');
  assert.equal(externalIdFrom('SH', 'https://shopee.com.br/Fone-Bluetooth-i.77.1001'), '77.1001');
  assert.equal(externalIdFrom('SH', 'https://shopee.com.br/product/77/1001'), '77.1001');
  assert.equal(externalIdFrom('SH', 'https://s.shopee.com.br/abc'), null);
  assert.equal(externalIdFrom('ML', ''), null);
});

test('produtos: bloqueia duplicados no cadastro, na edição e na importação', async () => {
  const t = await boot();
  try {
    const api = t.client();
    await signup(api);
    const link = 'https://produto.mercadolivre.com.br/MLB-1234567890-air-fryer-_JM';
    const a = await api('POST', '/api/products', { ...PRODUTO, product_url: link });
    assert.equal(a.status, 201);
    assert.equal(a.data.product.external_id, 'MLB1234567890');
    assert.ok(a.data.product.price_checked_at);
    // mesmo anúncio com outro texto no link
    const dup = await api('POST', '/api/products', { ...PRODUTO, title: 'Outro nome', product_url: 'https://produto.mercadolivre.com.br/MLB-1234567890-outro' });
    assert.equal(dup.status, 409);
    const b = await api('POST', '/api/products', { ...PRODUTO, product_url: 'https://produto.mercadolivre.com.br/MLB-999999999-x' });
    assert.equal(b.status, 201);
    const edit = await api('PATCH', `/api/products/${b.data.product.id}`, { product_url: link });
    assert.equal(edit.status, 409);
    // editar só o preço não conflita e renova a data de conferência
    const ok = await api('PATCH', `/api/products/${b.data.product.id}`, { price: '150' });
    assert.equal(ok.status, 200);
    const csv = 'titulo;marketplace;preco;link\nAir Fryer;ML;189,90;' + link + '\nNovo;SH;20;https://shopee.com.br/x-i.1.2\n';
    const imp = await api('POST', '/api/products/import', csv);
    assert.deepEqual([imp.data.imported, imp.data.skipped, imp.data.errors.length], [1, 1, 0]);
    // outra conta pode ter o mesmo produto
    const api2 = t.client();
    await signup(api2, 'b@exemplo.com');
    assert.equal((await api2('POST', '/api/products', { ...PRODUTO, product_url: link })).status, 201);
  } finally { t.close(); }
});

test('garimpo Shopee: conecta com teste, busca na hora, filtra, salva e atualiza preço', async () => {
  const opts = { shopee: {} };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const semConexao = await api('POST', '/api/garimpo/search', { marketplace: 'SH', q: 'fone' });
    assert.equal(semConexao.status, 400);
    assert.match(semConexao.data.error, /Conecte a Shopee/);

    opts.shopee.reject = true;
    const bad = await api('PUT', '/api/connections/shopee', { app_id: '18123456789', secret: 'segredo-da-shopee-123' });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /recusou/);
    opts.shopee.reject = false;
    assert.equal((await api('PUT', '/api/connections/shopee', { app_id: '18123456789', secret: 'segredo-da-shopee-123' })).status, 200);
    const call = t.calls.filter((c) => c.path === '/graphql').pop();
    assert.match(call.headers.authorization, /^SHA256 Credential=18123456789, Timestamp=\d+, Signature=[0-9a-f]{64}$/);
    const row = (await t.pool.query(`select secret_enc from marketplace_connections where marketplace = 'SH'`)).rows[0];
    assert.ok(!row.secret_enc.includes('segredo-da-shopee'));

    const st = await api('GET', '/api/connections/marketplaces');
    assert.equal(st.data.SH.connected, true);

    const r = await api('POST', '/api/garimpo/search', { marketplace: 'SH', q: 'fone "bluetooth"', sort: 'comissao' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.items.length, 2);
    const p = r.data.items[0];
    assert.equal(p.external_id, '77.1001');
    assert.equal(p.commission_pct, 12);
    assert.equal(p.rating, 4.8);
    assert.equal(p.sales_k, 15.3);
    assert.equal(p.desc, 40);
    assert.equal(p.affiliate_url, 'https://s.shopee.com.br/af1001');
    assert.ok(p.score > 0);
    assert.match(t.calls.filter((c) => c.path === '/graphql').pop().gql, /keyword: "fone \\"bluetooth\\"", sortType: 5/);

    const filtrado = await api('POST', '/api/garimpo/search', { marketplace: 'SH', q: 'fone', min_rating: 4.9 });
    assert.equal(filtrado.data.items.length, 0);

    const save = await api('POST', '/api/garimpo/save', { items: r.data.items });
    assert.deepEqual([save.data.saved, save.data.skipped], [2, 0]);
    const again = await api('POST', '/api/garimpo/save', { items: [r.data.items[0]] });
    assert.deepEqual([again.data.saved, again.data.skipped], [0, 1]);
    const r2 = await api('POST', '/api/garimpo/search', { marketplace: 'SH', q: 'fone' });
    assert.ok(r2.data.items.every((x) => x.saved_id));

    const prod = save.data.products.find((x) => x.external_id === '77.1001');
    await t.pool.query(`update products set price_checked_at = now() - interval '3 days' where id = $1`, [prod.id]);
    opts.shopee.itemPrice = 49.9;
    const ref = await api('POST', `/api/products/${prod.id}/refresh`);
    assert.equal(ref.status, 200, JSON.stringify(ref.data));
    assert.equal(ref.data.previous_price, 59.9);
    assert.equal(ref.data.product.price, 49.9);
    assert.ok(Date.now() - new Date(ref.data.product.price_checked_at).getTime() < 60000);
    assert.match(t.calls.filter((c) => c.path === '/graphql').pop().gql, /shopId: 77, itemId: 1001/);
  } finally { t.close(); }
});

test('garimpo Mercado Livre: autorização com PKCE, busca com comissão padrão, catálogo e token renovado', async () => {
  const opts = { ml: {} };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const put = await api('PUT', '/api/connections/mercadolivre', { client_id: '1234567890123', client_secret: 'segredo-do-ml-abc', default_commission: '8' });
    assert.equal(put.status, 200);
    assert.equal(put.data.authorize, '/api/connections/mercadolivre/authorize');
    let st = await api('GET', '/api/connections/marketplaces');
    assert.deepEqual([st.data.ML.connected, st.data.ML.authorized, st.data.ML.default_commission], [true, false, 8]);
    assert.equal(st.data.ML.redirect_uri, 'https://app.exemplo.com/api/connections/mercadolivre/callback');
    assert.equal((await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'air fryer' })).status, 400);

    const auth = await api('GET', '/api/connections/mercadolivre/authorize');
    assert.equal(auth.status, 302);
    const to = new URL(auth.location);
    assert.equal(to.hostname, 'auth.mercadolivre.com.br');
    assert.equal(to.searchParams.get('client_id'), '1234567890123');
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    const state = to.searchParams.get('state');

    const forged = await api('GET', `/api/connections/mercadolivre/callback?code=TG-1&state=outro`);
    assert.match(forged.location, /ml=erro/);
    // o cookie da tentativa foi apagado; uma nova autorização é necessária
    const auth2 = await api('GET', '/api/connections/mercadolivre/authorize');
    const state2 = new URL(auth2.location).searchParams.get('state');
    assert.notEqual(state2, state);
    const cb = await api('GET', `/api/connections/mercadolivre/callback?code=TG-1&state=${state2}`);
    assert.equal(cb.location, '/?ml=ok#conexoes');
    const tokenCall = t.calls.filter((c) => c.path === '/oauth/token').pop();
    assert.equal(tokenCall.body.grant_type, 'authorization_code');
    assert.ok(tokenCall.body.code_verifier.length >= 43);
    st = await api('GET', '/api/connections/marketplaces');
    assert.equal(st.data.ML.authorized, true);

    const r = await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'air fryer', sort: 'preco' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.items.map((x) => x.external_id), ['MLB222', 'MLB111']);
    const p = r.data.items[0];
    assert.equal(p.commission_pct, 8);
    assert.equal(p.sales_k, 2.5);
    assert.equal(p.affiliate_url, null);
    assert.equal(p.image_url, 'https://http2.mlstatic.com/D_MLB222-O.jpg');
    assert.equal(t.calls.filter((c) => c.path === '/sites/MLB/search').pop().auth, 'Bearer APP_USR-token-1');

    opts.ml.search403 = true;
    const cat = await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'air fryer' });
    assert.equal(cat.status, 200, JSON.stringify(cat.data));
    // só o produto que tem vendedor; preço = oferta mais barata; ranking de mais vendidos
    assert.equal(cat.data.items.length, 1);
    const c0 = cat.data.items[0];
    assert.deepEqual([c0.external_id, c0.price, c0.original_price, c0.best_seller_rank, c0.commission_pct], ['MLB9001', 299.9, 399.9, 3, 8]);
    assert.equal(c0.product_url, 'https://www.mercadolivre.com.br/p/MLB9001');
    const savedCat = await api('POST', '/api/garimpo/save', { items: [c0] });
    opts.ml.catalogPrice = 259.9;
    const refCat = await api('POST', `/api/products/${savedCat.data.products[0].id}/refresh`);
    assert.equal(refCat.status, 200, JSON.stringify(refCat.data));
    assert.equal(refCat.data.product.price, 259.9);
    opts.ml.search403 = false;

    const save = await api('POST', '/api/garimpo/save', { items: [p] });
    assert.equal(save.data.saved, 1);
    const prod = save.data.products[0];

    // token vencido: renova com o refresh token antes de consultar o preço
    await t.pool.query(`update marketplace_connections set token_expires_at = now() - interval '1 hour'`);
    opts.ml.itemPrice = 179.9;
    const ref = await api('POST', `/api/products/${prod.id}/refresh`);
    assert.equal(ref.status, 200, JSON.stringify(ref.data));
    assert.equal(ref.data.product.price, 179.9);
    assert.equal(ref.data.product.commission_pct, 8);
    assert.equal(t.calls.filter((c) => c.path === '/oauth/token').pop().body.grant_type, 'refresh_token');
    assert.equal(t.calls.filter((c) => c.path.startsWith('/items/')).pop().auth, 'Bearer APP_USR-token-2');

    // atualizar só a comissão mantém a autorização
    assert.equal((await api('PUT', '/api/connections/mercadolivre', { default_commission: '10' })).status, 200);
    st = await api('GET', '/api/connections/marketplaces');
    assert.deepEqual([st.data.ML.authorized, st.data.ML.default_commission], [true, 10]);
  } finally { t.close(); }
});
test('postar agora: prévia sem gravar, Instagram na hora, WhatsApp registrado e erros sem lixo na fila', async () => {
  const t = await boot();
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;

    const prev = await api('POST', '/api/queue/preview', { product_id: p.id, channel: 'instagram' });
    assert.equal(prev.status, 200);
    assert.match(prev.data.caption, /Air Fryer/);
    assert.equal(prev.data.media_type, 'image');
    assert.equal((await api('GET', '/api/queue')).data.items.length, 0);

    // sem Instagram conectado: recusa antes de gravar
    const semConexao = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Oferta', media_type: 'image', media_url: PRODUTO.image_url });
    assert.equal(semConexao.status, 400);
    assert.match(semConexao.data.error, /Conecte sua conta do Instagram/);
    assert.equal((await api('GET', '/api/queue')).data.items.length, 0);

    assert.equal((await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN })).status, 200);
    // sem mídia: recusa antes de gravar
    const semMidia = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Oferta' });
    assert.equal(semMidia.status, 400);
    assert.match(semMidia.data.error, /foto ou um vídeo/);
    assert.equal((await api('GET', '/api/queue')).data.items.length, 0);

    const ig = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Texto editado na hora', media_type: 'image', media_url: PRODUTO.image_url });
    assert.equal(ig.status, 201, JSON.stringify(ig.data));
    assert.equal(ig.data.item.status, 'posted');
    assert.equal(ig.data.item.caption, 'Texto editado na hora');
    assert.equal(ig.data.item.permalink, 'https://instagram.com/p/abc');
    const media = t.calls.find((c) => c.path.endsWith('/media') && c.method === 'POST');
    assert.equal(media.body.caption, 'Texto editado na hora');

    const wa = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'whatsapp', caption: 'Oferta no grupo' });
    assert.equal(wa.status, 201);
    assert.equal(wa.data.item.status, 'posted');
    assert.ok(wa.data.item.posted_at);

    assert.equal((await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'whatsapp', caption: '  ' })).status, 400);
    assert.equal((await api('POST', '/api/queue/post-now', { product_id: 99999, channel: 'whatsapp', caption: 'x' })).status, 404);
    const items = (await api('GET', '/api/queue')).data.items;
    assert.deepEqual(items.map((i) => i.status).sort(), ['posted', 'posted']);
  } finally { t.close(); }
});

test('postar agora: falha da Meta fica na fila como Falhou, sem o token', async () => {
  const t = await boot({}, { failMedia: true });
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    const r = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Oferta', media_type: 'image', media_url: PRODUTO.image_url });
    assert.equal(r.status, 502);
    assert.ok(!r.data.error.includes(TOKEN));
    const items = (await api('GET', '/api/queue')).data.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'failed');
  } finally { t.close(); }
});
test('Mercado Livre profissional: tendências, categorias, selos, galeria, texto rico, histórico e atualizar todos', async () => {
  const opts = { ml: { search403: true } };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    await api('PUT', '/api/connections/mercadolivre', { client_id: '1234567890123', client_secret: 'segredo-do-ml-abc', default_commission: '8' });
    const auth = await api('GET', '/api/connections/mercadolivre/authorize');
    await api('GET', `/api/connections/mercadolivre/callback?code=TG-1&state=${new URL(auth.location).searchParams.get('state')}`);

    const tr = await api('GET', '/api/garimpo/trends');
    assert.deepEqual(tr.data.trends, ['air fryer', 'fone bluetooth']);
    assert.equal((await api('GET', '/api/garimpo/trends?category=MLB1648')).data.trends[1], 'trend da categoria');
    assert.equal((await api('GET', '/api/garimpo/trends?category=../x')).status, 400);
    const cats = await api('GET', '/api/garimpo/categories');
    assert.equal(cats.data.categories[0].name, 'Eletrodomésticos');

    // mais vendidos de uma categoria, sem digitar nada (USER_PRODUCT fica de fora)
    const byCat = await api('POST', '/api/garimpo/search', { marketplace: 'ML', category: 'MLB5726' });
    assert.equal(byCat.status, 200, JSON.stringify(byCat.data));
    assert.equal(byCat.data.items.length, 1);
    const p = byCat.data.items[0];
    assert.deepEqual([p.best_seller_rank, p.free_shipping, p.full, p.official_store, p.sellers, p.brand], [3, true, true, true, 2, 'Elgin']);
    assert.equal(p.images.length, 2);
    assert.ok(p.images.every((u) => u.startsWith('https://')));
    assert.equal(p.features[0], 'Capacidade de 4,2 L para porções individuais.');
    assert.equal((await api('POST', '/api/garimpo/search', { marketplace: 'SH', category: 'MLB5726' })).status, 400);
    assert.equal((await api('POST', '/api/garimpo/search', { marketplace: 'ML', category: 'xyz' })).status, 400);

    // só frete grátis: na busca por texto o item do catálogo tem frete grátis; filtro mantém
    const free = await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'air fryer', free_shipping: true });
    assert.ok(free.data.items.length >= 1 && free.data.items.every((x) => x.free_shipping));

    // salvar guarda os detalhes (mesmo enviando o item "magro", o servidor completa pela loja)
    const save = await api('POST', '/api/garimpo/save', { items: [{ marketplace: 'ML', external_id: 'MLB9001', title: 'Air Fryer', price: 299.9, product_url: 'https://www.mercadolivre.com.br/p/MLB9001', commission_pct: 8 }] });
    assert.equal(save.data.saved, 1, JSON.stringify(save.data));
    const prod = save.data.products[0];
    assert.equal(prod.features.length, 2);
    assert.equal(prod.free_shipping, true);
    assert.ok(!('extras' in prod));

    // texto do post usa frete grátis/Full, loja oficial, ranking e características
    const prev = await api('POST', '/api/queue/preview', { product_id: prod.id, channel: 'instagram' });
    assert.match(prev.data.caption, /frete grátis com entrega Full/i);
    assert.match(prev.data.caption, /loja oficial/i);
    assert.match(prev.data.caption, /Capacidade de 4,2 L/);

    // histórico: preço muda em duas conferências; "atualizar todos" informa o que mudou
    opts.ml.catalogPrice = 279.9;
    const ref = await api('POST', `/api/products/${prod.id}/refresh`);
    assert.equal(ref.data.product.price, 279.9);
    assert.equal(ref.data.product.price_stats.previous, 299.9);
    opts.ml.catalogPrice = 259.9;
    const all = await api('POST', '/api/products/refresh-all');
    assert.equal(all.status, 200, JSON.stringify(all.data));
    assert.deepEqual([all.data.checked, all.data.changed.length, all.data.changed[0].to, all.data.remaining], [1, 1, 259.9, 0]);
    const hist = await api('GET', `/api/products/${prod.id}/history`);
    assert.deepEqual(hist.data.history.map((h) => h.price), [299.9, 279.9, 259.9]);
    const list = (await api('GET', '/api/products')).data.products[0];
    assert.deepEqual([list.price_stats.min, list.price_stats.max, list.price_stats.count], [259.9, 299.9, 3]);
    // "de R$ 399,90" nunca visto, mas o histórico ainda é curto: sem alerta
    assert.equal(list.price_stats.inflated_original, false);
    assert.equal((await api('GET', '/api/products/99999/history')).status, 404);

    // com 10 dias de histórico e o "preço de" nunca visto, vira alerta de desconto suspeito
    await t.pool.query(`update price_history set checked_at = now() - interval '10 days' where price = 299.9`);
    const sus = (await api('GET', '/api/products')).data.products[0];
    assert.equal(sus.price_stats.inflated_original, true);
    // se o produto já custou perto do "preço de", não acusa
    await t.pool.query('update products set original_price = 310 where id = $1', [prod.id]);
    assert.equal((await api('GET', '/api/products')).data.products[0].price_stats.inflated_original, false);

    // outra conta não vê o histórico
    const api2 = t.client();
    await signup(api2, 'b@exemplo.com');
    assert.equal((await api2('GET', `/api/products/${prod.id}/history`)).status, 404);
  } finally { t.close(); }
});
test('comissão: Shopee vem da loja; Mercado Livre pela tabela por categoria, sem sobrescrever a digitada', async () => {
  const opts = { ml: { search403: true } };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    await api('PUT', '/api/connections/mercadolivre', { client_id: '1234567890123', client_secret: 'segredo-do-ml-abc' });
    const auth = await api('GET', '/api/connections/mercadolivre/authorize');
    await api('GET', `/api/connections/mercadolivre/callback?code=TG-1&state=${new URL(auth.location).searchParams.get('state')}`);

    // sem padrão e sem tabela: comissão desconhecida, mas a categoria principal já vem
    let r = await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'air fryer' });
    let it = r.data.items[0];
    assert.deepEqual([it.commission_pct, it.category, it.category_id, it.earn_per_sale], [null, 'Eletrodomésticos', 'MLB5726', 0]);

    // salva sem comissão; depois a tabela preenche e recalcula o produto salvo
    const saved = (await api('POST', '/api/garimpo/save', { items: [it] })).data.products[0];
    assert.equal(saved.commission_pct, null);
    assert.equal(saved.category, 'Eletrodomésticos');
    assert.equal((await api('PUT', '/api/connections/mercadolivre/commissions', { table: { MLB5726: 'x' } })).status, 400);
    assert.equal((await api('PUT', '/api/connections/mercadolivre/commissions', { table: { '../x': 5 } })).status, 400);
    const tb = await api('PUT', '/api/connections/mercadolivre/commissions', { table: { MLB5726: '6,5', MLB1648: '' } });
    assert.equal(tb.status, 200, JSON.stringify(tb.data));
    assert.deepEqual([tb.data.table, tb.data.updated], [{ MLB5726: 6.5 }, 1]);
    let prod = (await api('GET', '/api/products')).data.products[0];
    assert.deepEqual([prod.commission_pct, prod.earn_per_sale], [6.5, 19.49]);
    assert.deepEqual((await api('GET', '/api/connections/marketplaces')).data.ML.commission_table, { MLB5726: 6.5 });

    // busca nova já usa a tabela
    r = await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'air fryer' });
    assert.equal(r.data.items[0].commission_pct, 6.5);

    // editar outro campo (o formulário manda a comissão igual) não trava a comissão automática
    await api('PATCH', `/api/products/${prod.id}`, { affiliate_url: 'https://mercadolivre.com/sec/xyz', commission_pct: '6,5' });
    await api('PUT', '/api/connections/mercadolivre/commissions', { table: { MLB5726: 7 } });
    prod = (await api('GET', '/api/products')).data.products[0];
    assert.equal(prod.commission_pct, 7);

    // comissão digitada pelo usuário vale sobre a tabela e sobre o "atualizar preço"
    await api('PATCH', `/api/products/${prod.id}`, { commission_pct: '12' });
    const upd = await api('PUT', '/api/connections/mercadolivre/commissions', { table: { MLB5726: 5 } });
    assert.equal(upd.data.updated, 0);
    const ref = await api('POST', `/api/products/${prod.id}/refresh`);
    assert.equal(ref.data.product.commission_pct, 12);

    // comissão padrão vale para categorias sem valor na tabela
    await api('PUT', '/api/connections/mercadolivre/commissions', { table: {} });
    await api('PUT', '/api/connections/mercadolivre', { default_commission: '4' });
    r = await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'air fryer' });
    assert.equal(r.data.items[0].commission_pct, 4);
  } finally { t.close(); }
});