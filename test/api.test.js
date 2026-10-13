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

function makeMockFetch(log, { failMedia = false, videoStates = [], childStates = [], carouselStates = [], shopee = {}, ml = {}, meta = {} } = {}) {
  let child = 0;
  return async (url, opts = {}) => {
    const u = new URL(String(url));
    const body = opts.body instanceof URLSearchParams ? Object.fromEntries(opts.body) : null;
    log.push({ method: opts.method || 'GET', url: String(url), path: u.pathname, query: Object.fromEntries(u.searchParams), body });
    const json = (status, data) => ({ ok: status < 400, status, json: async () => data });
    if (u.hostname === 'graph.instagram.com' && u.pathname === '/refresh_access_token') {
      return json(200, { access_token: 'IGAA-renovado-' + u.searchParams.get('access_token').slice(-4), token_type: 'bearer', expires_in: 5184000 });
    }
    if ((u.hostname === 'graph.facebook.com' || u.hostname === 'graph.instagram.com') && meta.rateLimit) {
      return json(400, { error: { message: 'Application request limit reached', type: 'OAuthException', code: 4 } });
    }
    if (u.hostname === 'graph.facebook.com' || u.hostname === 'graph.instagram.com') {
      if (u.pathname.endsWith('/media_publish')) {
        const ts = new Date().toISOString().replace(/\.\d+Z$/, '+0000');
        if (meta.notReady > 0) { meta.notReady--; return json(400, { error: { message: 'Media ID is not available', code: 9007, error_subcode: 2207027 } }); }
        if (meta.publishErr) {
          meta.published = meta.reallyPublishes !== false;
          if (meta.published) (meta.posts = meta.posts || []).unshift({ id: 'MEDIA_9', permalink: 'https://instagram.com/p/xyz', caption: meta.lastCaption, timestamp: ts });
          return json(400, { error: { message: 'Application request limit reached', code: 4 } });
        }
        (meta.posts = meta.posts || []).unshift({ id: 'MEDIA_1', permalink: 'https://instagram.com/p/abc', caption: meta.lastCaption, timestamp: ts });
        return json(200, { id: 'MEDIA_1' });
      }
      if (u.pathname.endsWith('/media') && (opts.method || 'GET') === 'GET') return json(200, { data: meta.posts || [] });
      if (u.pathname.endsWith('/media')) {
        if (failMedia) return json(400, { error: { message: `Invalid token ${body.access_token}` } });
        if (meta.fetchFail > 0) { meta.fetchFail--; return json(400, { error: { message: 'Only photo or video can be accepted as media type.', code: 9004, error_subcode: 2207052 } }); }
        if (body.caption) meta.lastCaption = body.caption;
        if (body.is_carousel_item) return json(200, { id: `CHILD_${++child}` });
        if (body.media_type === 'CAROUSEL' && meta.carouselZero > 0) { meta.carouselZero--; return json(200, { id: '0' }); }
        if (body.media_type === 'CAROUSEL') return json(200, { id: 'CAROUSEL_1' });
        return json(200, { id: 'CONTAINER_1' });
      }
      if (u.pathname.endsWith('/MEDIA_1')) return json(200, { permalink: 'https://instagram.com/p/abc' });
      if (/\/CHILD_\d+$/.test(u.pathname)) return json(200, { status_code: childStates.length ? childStates.shift() : 'FINISHED' });
      if (meta.published && /\/(CAROUSEL_1|CONTAINER_1)$/.test(u.pathname)) return json(200, { status_code: 'PUBLISHED' });
      if (u.pathname.endsWith('/CAROUSEL_1')) return json(200, { status_code: carouselStates.length ? carouselStates.shift() : 'FINISHED' });
      if (u.pathname.endsWith('/CONTAINER_1')) {
        const s = videoStates.length ? videoStates.shift() : 'FINISHED';
        return json(200, { status_code: s, status: s === 'ERROR' ? 'Error: Media upload has failed with error code 2207026' : s });
      }
      return json(200, { username: 'loja_teste' });
    }
    if (u.hostname === 'api.telegram.org') {
      const tg = shopee.tg || (shopee.tg = { sent: [] });
      const method = u.pathname.split('/').pop();
      const b = JSON.parse(opts.body || '{}');
      log[log.length - 1].tg = { method, ...b };
      if (!u.pathname.includes('/bot123456:')) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      if (method === 'getMe') return json(200, { ok: true, result: { id: 1, username: 'anninha_bot', first_name: 'Anninha' } });
      if (method === 'getUpdates') return json(200, { ok: true, result: [{ my_chat_member: { chat: { id: -1001234567890, title: 'Achadinhos da Anninha', type: 'supergroup' } } }, { message: { chat: { id: 55, type: 'private' } } }] });
      if (method === 'getChat') return b.chat_id === '@naoexiste' ? json(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }) : json(200, { ok: true, result: { id: -1001234567890, title: 'Achadinhos da Anninha', type: 'supergroup' } });
      tg.sent.push({ method, ...b });
      return json(200, { ok: true, result: { message_id: tg.sent.length } });
    }
    if (u.hostname === 'api.anthropic.com') {
      return json(200, { content: [{ type: 'text', text: 'Legenda gerada pela IA' }] });
    }
    // links de produto: curto da Shopee (redireciona; prévia só para quem pede como gerador de prévia) e do Mercado Livre
    const page = (status, html, location) => ({ ok: status < 400, status, url: String(url), headers: { get: (k) => (k.toLowerCase() === 'location' ? location || null : 'text/html') }, text: async () => html, json: async () => ({}) });
    if (u.hostname === 's.shopee.com.br') {
      if (u.pathname === '/fora') return page(301, '', 'https://evil.example.com/x');
      if (opts.redirect === 'manual') return page(301, '', 'https://shopee.com.br/lojinha/111/222?__mobile__=1');
      return page(200, '<html><head><meta property="og:title" content="Kit Marmita Infantil com Copo...">'
        + '<meta name="description" content="Compre Kit Marmita Infantil com Copo 250ml &#43; Talher &amp; Cia na Shopee Brasil! KIT COMPLETO PARA A HORA DO LANCHE">'
        + '<meta property="og:image" content="https://down-br.img.susercontent.com/file/abc"></head></html>');
    }
    if (u.hostname === 'shopee.com.br') return page(200, '<html><body>app</body></html>');
    if (u.hostname === 'mercadolivre.com' && u.pathname === '/sec/abc') return page(301, '', 'https://www.mercadolivre.com.br/air-fryer/p/MLB9001');
    if (u.hostname === 'www.mercadolivre.com.br') return page(200, '<html></html>');
    if (u.hostname === 'evil.example.com') { ml.evilHit = true; return page(200, '<html></html>'); }
    if (u.hostname.endsWith('mlstatic.com') && ml.imgs && ml.imgs[u.pathname]) {
      const buf = ml.imgs[u.pathname];
      return { ok: true, status: 200, url: String(url), headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
    }
    if (u.hostname.endsWith('mlstatic.com')) {
      const isImg = u.pathname.endsWith('.jpg');
      return { ok: true, status: 200, url: String(url), headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (isImg ? 'image/jpeg' : 'text/html; charset=utf-8') : null) },
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).buffer, json: async () => ({}) };
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
        return json(200, { paging: { total: 3 }, results: [{ item_id: 'MLB5', category_id: 'MLB456045', price: ml.catalogPrice || 299.9, original_price: 399.9, official_store_id: 2707, warranty: 'Garantia de fábrica: 12 meses', shipping: { free_shipping: !ml.notFree, logistic_type: 'fulfillment' } }, { item_id: 'MLB6', price: 319.9, shipping: { free_shipping: false } }, { item_id: 'MLB7', price: 99, shipping: { free_shipping: true } }] });
      }
      if (u.pathname === '/products/MLB9002/items') return json(200, { results: [] });
      if (u.pathname === '/products/MLB9001') return json(200, { id: 'MLB9001', name: 'Air Fryer Catálogo', pictures: [{ url: 'https://http2.mlstatic.com/D_9001-F.jpg' }, { url: 'http://http2.mlstatic.com/D_9001b-F.jpg' }], main_features: [{ text: 'Capacidade de 4,2 L para porções individuais.' }, { text: 'Potência de 1400 W.' }], attributes: [{ id: 'BRAND', value_name: 'Elgin' }] });
      if (u.pathname.startsWith('/products/')) return json(404, { message: 'not found' });
      if (u.pathname === '/sites/MLB/domain_discovery/search') return json(200, [{ category_id: 'MLB456045' }]);
      if (u.pathname.startsWith('/highlights/MLB/category/')) return json(200, { content: [{ id: 'MLB9001', position: 3, type: 'PRODUCT' }, { id: 'MLB7777', position: 4, type: 'USER_PRODUCT' }] });
      if (u.pathname === '/trends/MLB' || u.pathname.startsWith('/trends/MLB/')) return json(200, [{ keyword: 'air fryer' }, { keyword: u.pathname.length > 11 ? 'trend da categoria' : 'fone bluetooth' }]);
      if (u.pathname === '/categories/MLB456045') return json(200, { id: 'MLB456045', path_from_root: [{ id: 'MLB5726', name: 'Eletrodomésticos' }, { id: 'MLB456045', name: 'De Ar' }] });
      if (u.pathname === '/sites/MLB/categories') return json(200, [{ id: 'MLB5726', name: 'Eletrodomésticos' }, { id: 'MLB1648', name: 'Informática' }]);
      if (/^\/items\/[^/]+\/shipping_options$/.test(u.pathname)) {
        ml.shipCalls = (ml.shipCalls || []).concat(u.searchParams.get('zip_code'));
        return json(200, { options: [{ cost: ml.shipCost ?? 42.99 }, { cost: (ml.shipCost ?? 42.99) - 2 }] });
      }
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

  // erro do Instagram: na 1ª vez confere de novo (pode ser passageiro); na 2ª desiste e mostra o motivo da Meta
  const t2 = await boot({ videoInlinePolls: 1 }, { videoStates: ['IN_PROGRESS', 'ERROR', 'ERROR', 'ERROR'] });
  try {
    const b = t2.client();
    await signup(b);
    await conectarInstagram(b);
    const p2 = (await b('POST', '/api/products', { ...PRODUTO, image_url: '', video_url: 'https://cdn.exemplo.com/v.mp4' })).data.product;
    const it2 = (await b('POST', '/api/queue', { product_id: p2.id, channel: 'instagram' })).data.item;
    await b('POST', `/api/queue/${it2.id}/publish`);
    const chk1 = await b('POST', `/api/queue/${it2.id}/check`);
    assert.equal(chk1.data.item.status, 'processing');
    assert.match(chk1.data.item.error, /conferir de novo/);
    await t2.pool.query('update queue_items set next_check_at = null where id = $1', [it2.id]);
    const chk2 = await b('POST', `/api/queue/${it2.id}/check`);
    assert.equal(chk2.data.item.status, 'failed');
    assert.match(chk2.data.item.error, /não conseguiu processar o vídeo \(Error: Media upload has failed with error code 2207026\)\. Dica: o Instagram aceita MP4/);
  } finally { t2.close(); }
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
    // o motivo da falha aparece para o usuário (não só "Erro interno")
    assert.match(r.data.error, /Falha ao publicar: Invalid token/);
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
    // a oferta usada é a primeira (a que o site exibe), não a mais barata (R$ 99, que o site não mostra)
    assert.deepEqual([p.price, p.best_seller_rank, p.free_shipping, p.full, p.official_store, p.sellers, p.brand], [299.9, 3, true, true, true, 3, 'Elgin']);
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
test('carrossel: várias fotos do mesmo produto, vários produtos juntos e vídeo que demora para processar', async () => {
  const opts = { childStates: [] };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const a = (await api('POST', '/api/products', PRODUTO)).data.product;
    const b = (await api('POST', '/api/products', { ...PRODUTO, title: 'Fone Bluetooth', price: '59,90', original_price: 99.9, affiliate_url: 'https://mercadolivre.com/sec/fone', image_url: 'https://img.exemplo.com/fone.jpg' })).data.product;
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    const fotos = ['https://img.exemplo.com/1.jpg', 'https://img.exemplo.com/2.jpg', 'https://img.exemplo.com/3.jpg'].map((url) => ({ type: 'image', url }));

    // validações antes de gravar
    const um = await api('POST', '/api/queue/post-now', { product_id: a.id, channel: 'instagram', caption: 'x', media_type: 'carousel', media_items: fotos.slice(0, 1) });
    assert.equal(um.status, 400);
    const onze = await api('POST', '/api/queue/post-now', { product_id: a.id, channel: 'instagram', caption: 'x', media_type: 'carousel', media_items: Array(11).fill(fotos[0]) });
    assert.equal(onze.status, 400);
    const png = await api('POST', '/api/queue/post-now', { product_id: a.id, channel: 'instagram', caption: 'x', media_type: 'carousel', media_items: [fotos[0], { type: 'image', url: 'https://img.exemplo.com/x.png' }] });
    assert.equal(png.status, 400);
    assert.match(png.data.error, /JPEG/);
    assert.equal((await api('GET', '/api/queue')).data.items.length, 0);

    // várias fotos do mesmo produto
    const r = await api('POST', '/api/queue/post-now', { product_id: a.id, channel: 'instagram', caption: 'Três fotos', media_type: 'carousel', media_items: fotos });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.item.status, 'posted');
    assert.equal(r.data.item.media_type, 'carousel');
    assert.equal(JSON.parse(r.data.item.media_items).length, 3);
    const posts = t.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/media'));
    const kids = posts.filter((c) => c.body.is_carousel_item === 'true');
    assert.equal(kids.length, 3);
    assert.ok(kids.every((c) => !('caption' in c.body)));
    const car = posts.find((c) => c.body.media_type === 'CAROUSEL');
    assert.deepEqual([car.body.children, car.body.caption], ['CHILD_1,CHILD_2,CHILD_3', 'Três fotos']);
    assert.equal(t.calls.filter((c) => c.path.endsWith('/media_publish')).pop().body.creation_id, 'CAROUSEL_1');

    // vários produtos juntos: texto numerado com os dois e a foto de cada um
    const g = await api('POST', '/api/queue/preview-group', { product_ids: [b.id, a.id], channel: 'instagram' });
    assert.equal(g.status, 200);
    assert.match(g.data.caption, /2 achados/);
    assert.match(g.data.caption, /1️⃣ Fone Bluetooth por R\$\s?59,90 \(−40%\)/);
    assert.match(g.data.caption, /2️⃣ Air Fryer/);
    assert.deepEqual(g.data.media_items.map((m) => m.url), ['https://img.exemplo.com/fone.jpg', PRODUTO.image_url]);
    const gw = await api('POST', '/api/queue/preview-group', { product_ids: [a.id, b.id], channel: 'whatsapp' });
    assert.match(gw.data.caption, /👉 https:\/\/mercadolivre\.com\/sec\/abc[\s\S]*👉 https:\/\/mercadolivre\.com\/sec\/fone/);
    assert.equal((await api('POST', '/api/queue/preview-group', { product_ids: [a.id, 99999], channel: 'instagram' })).status, 404);
    const gp = await api('POST', '/api/queue/post-now', { product_ids: [b.id, a.id], channel: 'instagram', caption: g.data.caption, media_type: 'carousel', media_items: g.data.media_items });
    assert.equal(gp.status, 201, JSON.stringify(gp.data));
    assert.equal(gp.data.item.status, 'posted');
    assert.deepEqual(JSON.parse(gp.data.item.product_ids), [b.id, a.id]);
    assert.equal(gp.data.item.product_id, b.id);

    // carrossel com vídeo: fica processando e o "Verificar" publica quando o vídeo fica pronto
    opts.childStates.push(...Array(30).fill('IN_PROGRESS'));
    const v = await api('POST', '/api/queue/post-now', { product_id: a.id, channel: 'instagram', caption: 'Com vídeo', media_type: 'carousel', media_items: [fotos[0], { type: 'video', url: 'https://cdn.exemplo.com/v.mp4' }] });
    assert.equal(v.status, 201, JSON.stringify(v.data));
    assert.equal(v.data.item.status, 'processing');
    const vid = t.calls.filter((c) => c.body && c.body.is_carousel_item === 'true').pop();
    assert.deepEqual([vid.body.media_type, vid.body.video_url], ['VIDEO', 'https://cdn.exemplo.com/v.mp4']);
    opts.childStates.length = 0;
    const ck = await api('POST', `/api/queue/${v.data.item.id}/check`);
    assert.equal(ck.data.item.status, 'posted');

    // na Fila, trocar a mídia de um carrossel vira post simples
    const draft = (await api('POST', '/api/queue', { product_id: a.id, channel: 'instagram' })).data.item;
    await t.pool.query(`update queue_items set media_type = 'carousel', media_items = $1 where id = $2`, [JSON.stringify(fotos), draft.id]);
    const ch = await api('PATCH', `/api/queue/${draft.id}`, { media_type: 'image', media_url: 'https://img.exemplo.com/9.jpg' });
    assert.deepEqual([ch.data.item.media_type, ch.data.item.media_items], ['image', null]);
  } finally { t.close(); }
});
test('Instagram pelo login do Instagram: chave IG usa graph.instagram.com e é renovada sozinha', async () => {
  const t = await boot();
  try {
    const api = t.client();
    await signup(api);
    const IGTOKEN = 'IGAAT-token-do-login-do-instagram-123456';
    const conn = await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000001', access_token: IGTOKEN });
    assert.equal(conn.status, 200, JSON.stringify(conn.data));
    const who = t.calls.filter((c) => c.path.endsWith('/17841400000000001')).pop();
    assert.ok(who, 'conferiu o usuário');
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;
    const r = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Oferta', media_type: 'image', media_url: PRODUTO.image_url });
    assert.equal(r.data.item.status, 'posted', JSON.stringify(r.data));
    // todas as chamadas de publicação foram para graph.instagram.com
    const media = t.calls.filter((c) => c.path.endsWith('/media') || c.path.endsWith('/media_publish'));
    assert.equal(media.length, 2);
    assert.ok(media.every((c) => c.url.startsWith('https://graph.instagram.com/v')), media.map((c) => c.url).join());
    assert.ok(who.url.startsWith('https://graph.instagram.com/'));

    // token com mais de 7 dias: o agendador renova e grava o novo, criptografado
    await t.pool.query(`update connections set updated_at = now() - interval '8 days'`);
    const { refreshInstagramTokens } = require('../src/services/publisher');
    const n = await refreshInstagramTokens({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl, log: { error() {} } });
    assert.equal(n, 1);
    const { decrypt } = require('../src/util');
    const row = (await t.pool.query('select ig_token_enc from connections')).rows[0];
    assert.equal(decrypt(row.ig_token_enc, t.cfg.encryptionKey), 'IGAA-renovado-3456');
    // recém-renovado: não renova de novo
    assert.equal(await refreshInstagramTokens({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl }), 0);

    // chave do login do Facebook (EAA...) continua em graph.facebook.com e não é renovada por aqui
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    await t.pool.query(`update connections set updated_at = now() - interval '8 days'`);
    assert.equal(await refreshInstagramTokens({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl }), 0);
  } finally { t.close(); }
});
test('carrossel com vídeo: se o Instagram ainda prepara o carrossel, fica processando e publica depois (sem "Media ID is not available")', async () => {
  const opts = { carouselStates: [] };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    opts.carouselStates.push(...Array(10).fill('IN_PROGRESS'));
    const r = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Com vídeo', media_type: 'carousel',
      media_items: [{ type: 'video', url: 'https://cdn.exemplo.com/v.mp4' }, { type: 'image', url: 'https://img.exemplo.com/1.jpg' }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.item.status, 'processing');
    assert.equal(r.data.item.container_id, 'CAROUSEL_1');
    // não tentou publicar antes de o carrossel ficar pronto
    assert.equal(t.calls.filter((c) => c.path.endsWith('/media_publish')).length, 0);
    opts.carouselStates.length = 0;
    const ck = await api('POST', `/api/queue/${r.data.item.id}/check`);
    assert.equal(ck.data.item.status, 'posted');
    assert.equal(t.calls.filter((c) => c.path.endsWith('/media_publish')).pop().body.creation_id, 'CAROUSEL_1');
  } finally { t.close(); }
});
test('capa: repasse de imagem só para lojas/armazenamento, cor e @ da marca, @ do Instagram guardado', async () => {
  const t = await boot();
  try {
    const anon = t.client();
    assert.equal((await anon('GET', '/api/media/proxy?url=' + encodeURIComponent('https://http2.mlstatic.com/D_1-O.jpg'))).status, 401);
    const api = t.client();
    await signup(api);

    // repasse: imagem do Mercado Livre passa; outros endereços não
    const base = `http://127.0.0.1:${t.server.address().port}`;
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@exemplo.com', password: 'senha-forte-1' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = (u) => fetch(base + '/api/media/proxy?url=' + encodeURIComponent(u), { headers: { cookie } });
    const ok = await get('https://http2.mlstatic.com/D_NQ_NP_1-O.jpg');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())].slice(0, 3), [0xff, 0xd8, 0xff]);
    const before = t.calls.length;
    for (const bad of ['https://evil.example.com/x.jpg', 'http://http2.mlstatic.com/x.jpg', 'https://127.0.0.1/x.jpg', 'https://mlstatic.com.evil.com/x.jpg', 'file:///etc/passwd', 'nada']) {
      assert.equal((await get(bad)).status, 400, bad);
    }
    assert.equal(t.calls.length, before, 'endereços proibidos nem chegam a ser buscados');
    assert.equal((await get('https://http2.mlstatic.com/pagina.html')).status, 415);

    // marca: cor e @ salvos e devolvidos no /me
    assert.equal((await api('PUT', '/api/auth/brand', { color: 'rosa', handle: 'x' })).status, 400);
    assert.equal((await api('PUT', '/api/auth/brand', { color: '#E8457A', handle: 'a b' })).status, 400);
    const b = await api('PUT', '/api/auth/brand', { color: '#E8457A', handle: '@anninha.achados' });
    assert.deepEqual(b.data.brand, { color: '#E8457A', handle: 'anninha.achados' });
    assert.deepEqual((await api('GET', '/api/auth/me')).data.brand, { color: '#E8457A', handle: 'anninha.achados' });

    // @ do Instagram: guardado ao conectar; conexões antigas sem @ buscam uma vez
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    assert.equal((await api('GET', '/api/connections/instagram')).data.username, 'loja_teste');
    await t.pool.query('update connections set ig_username = null');
    assert.equal((await api('GET', '/api/connections/instagram')).data.username, 'loja_teste');
    assert.equal((await t.pool.query('select ig_username from connections')).rows[0].ig_username, 'loja_teste');
  } finally { t.close(); }
});
test('frete: CEP de referência, frete e total por produto, filtros "grátis" e "barato"', async () => {
  const opts = { ml: { search403: true, notFree: true } };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    await api('PUT', '/api/connections/mercadolivre', { client_id: '1234567890123', client_secret: 'segredo-do-ml-abc' });
    const auth = await api('GET', '/api/connections/mercadolivre/authorize');
    await api('GET', `/api/connections/mercadolivre/callback?code=TG-1&state=${new URL(auth.location).searchParams.get('state')}`);

    // sem CEP: frete desconhecido e nenhuma consulta
    let r = await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'air fryer' });
    assert.equal(r.data.items[0].shipping_cost, undefined);
    assert.equal(opts.ml.shipCalls, undefined);

    assert.equal((await api('PUT', '/api/auth/shipping', { zip: '123' })).status, 400);
    assert.equal((await api('PUT', '/api/auth/shipping', { zip: '17032-690' })).data.ship_zip, '17032690');
    assert.equal((await api('GET', '/api/auth/me')).data.ship_zip, '17032690');

    // com CEP: o frete mais barato até o CEP e o CEP usado
    r = await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'air fryer' });
    const p = r.data.items[0];
    assert.deepEqual([p.free_shipping, p.shipping_cost, p.shipping_zip], [false, 40.99, '17032690']);
    assert.ok(opts.ml.shipCalls.every((z) => z === '17032690'));

    // filtros: "só grátis" tira; "barato" (até 15% do preço: 299,90 x 0,15 = 44,99) mantém
    assert.equal((await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'air fryer', shipping: 'free' })).data.items.length, 0);
    assert.equal((await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'air fryer', shipping: 'cheap' })).data.items.length, 1);
    opts.ml.shipCost = 62;
    assert.equal((await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'fryer', shipping: 'cheap' })).data.items.length, 0);

    // salvo e atualizado: o frete vai junto e é recalculado
    const saved = (await api('POST', '/api/garimpo/save', { items: [p] })).data.products[0];
    assert.equal(saved.shipping_cost, 60);
    opts.ml.shipCost = 30;
    const ref = await api('POST', `/api/products/${saved.id}/refresh`);
    assert.equal(ref.data.product.shipping_cost, 28);

    // oferta com frete grátis: 0 sem consultar
    opts.ml.notFree = false;
    const n = opts.ml.shipCalls.length;
    r = await api('POST', '/api/garimpo/search', { marketplace: 'ML', q: 'airfryer grátis' });
    assert.equal(r.data.items[0].shipping_cost, 0);
    assert.equal(opts.ml.shipCalls.length, n);
  } finally { t.close(); }
});
test('cota da Meta: foto não é conferida, vídeo é conferido com pausa e limite atingido faz o app esperar', async () => {
  const opts = { childStates: [], meta: {} };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    const statusCalls = () => t.calls.filter((c) => c.method === 'GET' && /\/CHILD_\d+$/.test(c.path)).length;
    const fotos = [1, 2, 3, 4].map((i) => ({ type: 'image', url: `https://img.exemplo.com/${i}.jpg` }));

    // só fotos: nenhuma conferência de item
    const a = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Fotos', media_type: 'carousel', media_items: fotos });
    assert.equal(a.data.item.status, 'posted');
    assert.equal(statusCalls(), 0);

    // fotos + 1 vídeo demorando: confere só o vídeo (1 chamada por rodada, não 5)
    opts.childStates.push(...Array(20).fill('IN_PROGRESS'));
    const v = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Com vídeo', media_type: 'carousel',
      media_items: [...fotos, { type: 'video', url: 'https://cdn.exemplo.com/v.mp4' }] });
    assert.equal(v.data.item.status, 'processing');
    const rounds = statusCalls();
    assert.equal(rounds, t.cfg.videoInlinePolls);
    assert.match(v.data.item.container_id, /^children:(CHILD_\d+,){4}vCHILD_\d+$/);

    // primeira conferência (ainda processando) agenda a próxima para daqui a 1 min; conferir de novo agora não chama a Meta
    await api('POST', `/api/queue/${v.data.item.id}/check`);
    const after1 = statusCalls();
    assert.equal(after1, rounds + 1);
    await api('POST', `/api/queue/${v.data.item.id}/check`);
    assert.equal(statusCalls(), after1);

    // limite da Meta durante a conferência: espera 20 min, com aviso claro, e o agendador não insiste
    await t.pool.query('update queue_items set next_check_at = null where id = $1', [v.data.item.id]);
    opts.meta.rateLimit = true;
    await api('POST', `/api/queue/${v.data.item.id}/check`);
    let row = (await t.pool.query('select status, error, next_check_at from queue_items where id = $1', [v.data.item.id])).rows[0];
    assert.equal(row.status, 'processing');
    assert.match(row.error, /limitou as chamadas/);
    assert.ok(new Date(row.next_check_at).getTime() - Date.now() > 15 * 60 * 1000);
    const before = t.calls.length;
    const { processDue } = require('../src/services/publisher');
    await processDue({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl, log: { log() {}, error() {} } });
    assert.equal(t.calls.length, before, 'agendador não chamou a Meta durante a espera');

    // publicar com o limite atingido: 429 com mensagem clara, item na Fila como Falhou
    const r = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'x', media_type: 'image', media_url: PRODUTO.image_url });
    assert.equal(r.status, 429);
    assert.match(r.data.error, /limitou as chamadas do app/);
    const failed = (await api('GET', '/api/queue')).data.items.find((i) => i.status === 'failed');
    assert.match(failed.error, /Espere cerca de 1 hora/);
  } finally { t.close(); }
});
test('carrossel que falhou: "Publicar agora" reaproveita os itens já enviados (vídeo ficou pronto depois)', async () => {
  const opts = { childStates: [] };
  const t = await boot({ videoInlinePolls: 1 }, opts);
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    const media = [{ type: 'image', url: 'https://img.exemplo.com/1.jpg' }, { type: 'video', url: 'https://cdn.exemplo.com/v.mp4' }];
    // vídeo responde erro duas vezes: falha
    opts.childStates.push('ERROR', 'ERROR', 'ERROR');
    const r = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Patinete', media_type: 'carousel', media_items: media });
    assert.equal(r.data.item.status, 'processing');
    await t.pool.query('update queue_items set next_check_at = null');
    const ck = await api('POST', `/api/queue/${r.data.item.id}/check`);
    assert.equal(ck.data.item.status, 'failed');
    const created = () => t.calls.filter((c) => c.body && c.body.is_carousel_item === 'true').length;
    const before = created();
    // depois o Instagram termina o vídeo: publicar de novo usa os mesmos itens, sem reenviar
    opts.childStates.length = 0;
    const again = await api('POST', `/api/queue/${r.data.item.id}/publish`);
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.item.status, 'posted');
    assert.equal(created(), before, 'nenhum item reenviado');
    // trocar a mídia na Fila invalida os itens antigos
    const d = (await api('POST', '/api/queue', { product_id: p.id, channel: 'instagram' })).data.item;
    await t.pool.query(`update queue_items set container_id = 'children:CHILD_1,vCHILD_2', claimed_at = now() where id = $1`, [d.id]);
    const ch = await api('PATCH', `/api/queue/${d.id}`, { media_type: 'image', media_url: 'https://img.exemplo.com/9.jpg' });
    assert.equal(ch.data.item.container_id, null);
  } finally { t.close(); }
});
test('Meta publica mas responde erro: o app confere, marca como postado e não deixa duplicar', async () => {
  const opts = { meta: {} };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    const publishes = () => t.calls.filter((c) => c.path.endsWith('/media_publish')).length;

    // 1) erro na publicação, mas o post saiu: fica "postado" com o link encontrado
    opts.meta.publishErr = true;
    const r = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Carrossel do patinete', media_type: 'carousel',
      media_items: [{ type: 'image', url: 'https://img.exemplo.com/1.jpg' }, { type: 'image', url: 'https://img.exemplo.com/2.jpg' }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.item.status, 'posted');
    assert.equal(r.data.item.permalink, 'https://instagram.com/p/xyz');

    // 2) erro e o post NÃO saiu: falhou, com aviso para conferir antes de repetir
    opts.meta.published = false; opts.meta.reallyPublishes = false;
    const f = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Foto', media_type: 'image', media_url: PRODUTO.image_url });
    assert.equal(f.status, 429);
    assert.match(f.data.error, /confira no Instagram/);

    // 2b) post no ar com o container respondendo "ERROR" (como aconteceu de verdade): achado pela legenda e horário
    opts.meta.published = false; opts.meta.reallyPublishes = true; opts.meta.publishErr = true;
    opts.carouselStates = undefined;
    const e2 = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Patinete rosa', media_type: 'image', media_url: PRODUTO.image_url });
    assert.equal(e2.data.item.status, 'posted', JSON.stringify(e2.data));
    opts.meta.published = false; opts.meta.reallyPublishes = false;

    // 3) item que falhou mas cujo post saiu depois: "Publicar agora" não publica de novo
    // simula que aquele post (legenda "Foto") apareceu no perfil depois
    opts.meta.publishErr = false;
    opts.meta.posts.unshift({ id: 'MEDIA_7', permalink: 'https://instagram.com/p/foto', caption: 'Foto', timestamp: new Date().toISOString().replace(/\.\d+Z$/, '+0000') });
    const before = publishes();
    const again = await api('POST', `/api/queue/${f.data.item?.id || (await api('GET', '/api/queue')).data.items.find((i) => i.status === 'failed').id}/publish`);
    assert.equal(again.data.item.status, 'posted');
    assert.equal(publishes(), before, 'não chamou media_publish de novo');
  } finally { t.close(); }
});
test('cadastrar por links: Shopee pela prévia (sem preço), Mercado Livre pela API, só lojas permitidas', async () => {
  const opts = { ml: { search403: true } };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    await api('PUT', '/api/connections/mercadolivre', { client_id: '1234567890123', client_secret: 'segredo-do-ml-abc', default_commission: '8' });
    const auth = await api('GET', '/api/connections/mercadolivre/authorize');
    await api('GET', `/api/connections/mercadolivre/callback?code=TG-1&state=${new URL(auth.location).searchParams.get('state')}`);

    assert.equal((await api('POST', '/api/garimpo/from-links', { links: [] })).status, 400);
    const r = await api('POST', '/api/garimpo/from-links', { links: [
      'https://s.shopee.com.br/1gJKcHjxJh', 'https://mercadolivre.com/sec/abc', 'https://evil.example.com/x', 'https://s.shopee.com.br/fora', 'nada',
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const [sh, ml, evil, fora, nada] = r.data.items;
    // Shopee: nome inteiro (da descrição), foto, código e o link colado como link de afiliado; preço a completar
    assert.deepEqual([sh.marketplace, sh.external_id, sh.title, sh.price, sh.affiliate_url, sh.product_url],
      ['SH', '111.222', 'Kit Marmita Infantil com Copo 250ml + Talher & Cia', null, 'https://s.shopee.com.br/1gJKcHjxJh', 'https://shopee.com.br/product/111/222']);
    assert.equal(sh.image_url, 'https://down-br.img.susercontent.com/file/abc');
    // Mercado Livre: dados completos da API (preço, comissão da tabela/padrão) e o link de afiliado colado
    assert.deepEqual([ml.marketplace, ml.external_id, ml.price, ml.commission_pct, ml.source, ml.affiliate_url],
      ['ML', 'MLB9001', 299.9, 8, 'api', 'https://mercadolivre.com/sec/abc']);
    assert.match(evil.error, /Só links da Shopee ou do Mercado Livre/);
    assert.match(nada.error, /Link inválido/);
    assert.ok(fora.title || fora.error); // não segue para fora das lojas
    assert.equal(opts.ml.evilHit, undefined, 'nunca acessou o endereço de fora das lojas');

    // salva: Shopee com o preço digitado; Mercado Livre como veio
    const save = await api('POST', '/api/garimpo/save', { items: [{ ...sh, price: '49,90', original_price: '79,90', commission_pct: '10' }, ml] });
    assert.deepEqual([save.data.saved, save.data.errors.length], [2, 0], JSON.stringify(save.data));
    const prods = (await api('GET', '/api/products')).data.products;
    const ps = prods.find((x) => x.marketplace === 'SH');
    assert.deepEqual([ps.price, ps.original_price, ps.commission_pct, ps.affiliate_url, ps.external_id], [49.9, 79.9, 10, 'https://s.shopee.com.br/1gJKcHjxJh', '111.222']);
    // colar de novo: aparecem como já cadastrados
    const again = await api('POST', '/api/garimpo/from-links', { links: ['https://s.shopee.com.br/1gJKcHjxJh', 'https://mercadolivre.com/sec/abc'] });
    assert.ok(again.data.items.every((x) => x.saved_id));
  } finally { t.close(); }
});
test('planilha "Obter link em massa" da Shopee: lê preço, comissão, vendas e link; foto pela prévia; só busca na Shopee', async () => {
  const opts = { ml: {} };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const csv = [
      'Item Id,Item Name,Price,Sales,Nome da loja,Commission Rate,Commission,Product Link,Offer Link',
      '22499247158,Carregador Portátil Mini Power Bank 10000mAh Com 02 Saídas Tipo-C / Lightning,"31,99",10mil+,SHR ELETRONICOS,28%,"R$8,96",https://shopee.com.br/product/408715442/22499247158,https://s.shopee.com.br/5LCczJBazQ',
      '23394849645,Shorts Masculino Tactel Praia Academia Treino Corrida Verão Secagem Rápida,"35,00",66,F&A MIX ,83%,"R$29,05",https://shopee.com.br/product/1163397054/23394849645,https://s.shopee.com.br/5VW3BcAxeT',
      '55260497129,Kit Estética Automotiva Vonixx,"113,58",4mil+,Yamase Loja Oficial,14%,"R$15,90",https://shopee.com.br/product/316945044/55260497129,https://evil.example.com/x',
      '',
    ].join('\n');
    assert.equal((await api('POST', '/api/garimpo/from-shopee-csv', 'titulo;preco\nx;1\n')).status, 400);
    const r = await api('POST', '/api/garimpo/from-shopee-csv', csv);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const [a, b, c] = r.data.items;
    assert.deepEqual([a.title.slice(0, 22), a.price, a.commission_pct, a.sales_k, a.shop, a.external_id, a.affiliate_url],
      ['Carregador Portátil Mi', 31.99, 28, 10, 'SHR ELETRONICOS', '408715442.22499247158', 'https://s.shopee.com.br/5LCczJBazQ']);
    assert.equal(a.image_url, 'https://down-br.img.susercontent.com/file/abc');
    assert.equal(a.earn_per_sale, 8.96);
    assert.deepEqual([b.sales_k, b.commission_pct, b.shop], [0.066, 83, 'F&A MIX']);
    assert.equal(c.image_url, null, 'link de fora da Shopee não é buscado');
    assert.equal(opts.ml.evilHit, undefined);

    // salva em lote; depois os mesmos aparecem como já cadastrados
    const save = await api('POST', '/api/garimpo/save', { items: r.data.items });
    assert.deepEqual([save.data.saved, save.data.errors.length], [3, 0], JSON.stringify(save.data));
    const p = (await api('GET', '/api/products')).data.products.find((x) => x.external_id === '408715442.22499247158');
    assert.deepEqual([p.price, p.commission_pct, p.sales_k, p.notes, p.affiliate_url], [31.99, 28, 10, 'Loja: SHR ELETRONICOS', 'https://s.shopee.com.br/5LCczJBazQ']);
    assert.ok((await api('POST', '/api/garimpo/from-shopee-csv', csv)).data.items.every((x) => x.saved_id));

    // "Importar CSV" também reconhece a planilha da Shopee (em outra conta)
    const api2 = t.client();
    await signup(api2, 'b@exemplo.com');
    const imp = await api2('POST', '/api/products/import', csv);
    assert.deepEqual([imp.data.imported, imp.data.format], [3, 'shopee']);
  } finally { t.close(); }
});
test('texto do WhatsApp no estilo da Anninha: negrito, de/por riscado, destaques verdadeiros, link e sem prazo inventado', async () => {
  const { templateCopy, templateGroupCopy } = require('../src/services/copy');
  const p = { title: 'Air Fryer 4L', marketplace: 'ML', price: 239, original_price: 716.9, affiliate_url: 'https://meli.la/abc', sales_k: 12,
    extras: JSON.stringify({ free_shipping: true, full: true, best_seller_rank: 6 }) };
  for (let i = 0; i < 20; i++) { // as aberturas variam; todas seguem o formato
    const t = templateCopy(p, 'whatsapp');
    const lines = t.split('\n');
    assert.match(lines[0], /^\S+ \*[^*]+\*$/, 'abertura em negrito com emoji');
    assert.ok(t.includes('🛍️ *Air Fryer 4L*'));
    assert.ok(t.includes('💸 De: ~R$') && t.includes('716,90~'));
    assert.match(t, /💥 Por: \*R\$\s239,00\* \(−67% OFF\)/);
    assert.ok(t.includes('🚚 *Frete grátis* com entrega Full!'));
    assert.ok(t.includes('🏆 6º mais vendido da categoria'));
    assert.ok(t.includes('⭐ Mais de 12 mil vendidos'));
    assert.ok(t.includes('👉 https://meli.la/abc'));
    assert.doesNotMatch(t, /tempo limitado|só hoje|últimas unidades/i);
  }
  // sem desconto e sem destaques: "Por apenas", sem linha de frete inventada
  const s = templateCopy({ title: 'Garrafa', marketplace: 'SH', price: 20, affiliate_url: 'https://s.shopee.com.br/x' }, 'whatsapp');
  assert.ok(s.includes('💥 Por apenas: *R$'));
  assert.doesNotMatch(s, /Frete grátis|De: ~/);
  const g = templateGroupCopy([p, { title: 'Garrafa', marketplace: 'SH', price: 20, affiliate_url: 'https://s.shopee.com.br/x' }], 'whatsapp');
  assert.match(g, /1️⃣ \*Air Fryer 4L\*\n💥 \*R\$\s239,00\* ~R\$\s716,90~ \(−67%\) · 🚚 frete grátis\n👉 https:\/\/meli\.la\/abc/);
  assert.match(g, /2️⃣ \*Garrafa\*\n💥 \*R\$\s20,00\*\n👉 https:\/\/s\.shopee\.com\.br\/x/);
});
test('preço com variações (kits): "a partir de", "até R$" validado e texto honesto', async () => {
  const t = await boot();
  try {
    const api = t.client();
    await signup(api);
    const base = { title: 'Kit Bola De Natal', marketplace: 'SH', price: '28,90', original_price: '89,90', affiliate_url: 'https://s.shopee.com.br/k' };
    assert.equal((await api('POST', '/api/products', { ...base, price_max: '20' })).status, 400);
    const p = (await api('POST', '/api/products', { ...base, price_max: '110,80' })).data.product;
    assert.deepEqual([p.price, p.price_max], [28.9, 110.8]);

    const wa = (await api('POST', '/api/queue/preview', { product_id: p.id, channel: 'whatsapp' })).data.caption;
    assert.match(wa, /💥 A partir de: \*R\$\s28,90\* \(−68% OFF\)/);
    assert.ok(wa.includes('📦 Tem opções (kits/tamanhos): o preço muda conforme a escolha'));
    const ig = (await api('POST', '/api/queue/preview', { product_id: p.id, channel: 'instagram' })).data.caption;
    assert.match(ig, /a partir de R\$\s28,90/i);

    // editar: valor inválido recusado; vazio volta a preço único (e o texto volta ao normal)
    assert.equal((await api('PATCH', `/api/products/${p.id}`, { price_max: '10' })).status, 400);
    const cleared = (await api('PATCH', `/api/products/${p.id}`, { price_max: '' })).data.product;
    assert.equal(cleared.price_max, undefined);
    const wa2 = (await api('POST', '/api/queue/preview', { product_id: p.id, channel: 'whatsapp' })).data.caption;
    assert.match(wa2, /💥 Por: \*R\$\s28,90\*/);
    assert.ok(!wa2.includes('Tem opções'));

    // cadastro pela lista (links/planilha): "até" salvo só se fizer sentido
    const s = await api('POST', '/api/garimpo/save', { items: [
      { marketplace: 'SH', external_id: '1.2', title: 'Kit A', price: 10, price_max: '35,50', product_url: 'https://shopee.com.br/product/1/2' },
      { marketplace: 'SH', external_id: '1.3', title: 'Kit B', price: 10, price_max: '5', product_url: 'https://shopee.com.br/product/1/3' },
    ] });
    assert.equal(s.data.saved, 2);
    const byId = Object.fromEntries((await api('GET', '/api/products')).data.products.map((x) => [x.external_id, x]));
    assert.deepEqual([byId['1.2'].price_max, byId['1.3'].price_max], [35.5, undefined]);
  } finally { t.close(); }
});
test('Telegram: conecta o bot, escolhe o grupo, testa e o token não aparece', async () => {
  const opts = { shopee: {} };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const TG = '123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789';
    assert.equal((await api('PUT', '/api/connections/telegram', { token: 'abc' })).status, 400);
    const bad = await api('PUT', '/api/connections/telegram', { token: '999999:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789' });
    assert.equal(bad.status, 400);
    assert.ok(!JSON.stringify(bad.data).includes('ABCdefGHI'), 'erro não mostra o token');
    const ok = await api('PUT', '/api/connections/telegram', { token: TG });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const chats = await api('GET', '/api/connections/telegram/chats');
    assert.deepEqual(chats.data.chats.map((c) => c.title), ['Achadinhos da Anninha']);
    assert.equal((await api('PUT', '/api/connections/telegram/chat', { chat_id: '@naoexiste' })).status, 400);
    const pick = await api('PUT', '/api/connections/telegram/chat', { chat_id: '-1001234567890' });
    assert.equal(pick.status, 200, JSON.stringify(pick.data));
    const st = await api('GET', '/api/connections/telegram');
    assert.equal(st.data.ready, true);
    assert.equal(st.data.chat_title, 'Achadinhos da Anninha');
    assert.ok(!JSON.stringify(st.data).includes('ABCdef'));
    const enc = (await t.pool.query('select tg_token_enc from connections')).rows[0].tg_token_enc;
    assert.ok(!enc.includes('ABCdef'), 'token guardado criptografado');
    assert.equal(opts.shopee.tg.sent.length, 1, 'mensagem de teste enviada');
    assert.equal((await api('DELETE', '/api/connections/telegram')).status, 200);
    assert.equal((await api('GET', '/api/connections/telegram')).data.connected, false);
  } finally { t.close(); }
});

test('piloto automático: filtros, só com link de afiliado, não repete, janela, Telegram, Instagram com limite e WhatsApp na Fila', async () => {
  const opts = { shopee: {}, meta: {} };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const { runDue, inWindow, cleanConfig } = require('../src/services/automation');
    assert.equal(inWindow('23:30', { start: '20:00', end: '02:00' }), true);
    assert.equal(inWindow('12:00', { start: '20:00', end: '02:00' }), false);
    assert.throws(() => cleanConfig({ sources: { saved: true }, channels: {} }), /canal/);

    const mk = (o) => api('POST', '/api/products', { ...PRODUTO, ...o });
    const a = (await mk({ title: 'Air Fryer Boa', marketplace: 'SH' })).data.product; // 42% off, com link
    await mk({ title: 'Fone Sem Desconto', marketplace: 'SH', original_price: '', affiliate_url: 'https://s.shopee.com.br/x1' });
    await mk({ title: 'Panela Sem Link', marketplace: 'SH', affiliate_url: '' });

    await api('PUT', '/api/connections/telegram', { token: '123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789' });
    await api('PUT', '/api/connections/telegram/chat', { chat_id: '-1001234567890' });
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });

    assert.equal((await api('POST', '/api/automations', { name: 'x', config: { sources: { saved: false }, channels: { telegram: true } } })).status, 400);
    const cfg = { sources: { saved: true, marketplaces: ['SH'] }, filters: { min_discount: 30 }, window: { start: '00:00', end: '23:59' },
      interval_min: 60, dedup_days: 7, channels: { instagram: true, telegram: true, whatsapp: true }, ig_daily_max: 1 };
    const created = await api('POST', '/api/automations', { name: 'Ofertas Shopee', config: cfg });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;

    // rodada 1: só a Air Fryer passa (desconto e link); vai para os 3 canais
    const r1 = await api('POST', `/api/automations/${id}/run`);
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    assert.equal(r1.data.status, 'sent', JSON.stringify(r1.data));
    assert.equal(r1.data.title, 'Air Fryer Boa');
    assert.equal(r1.data.channels.telegram, 'enviado');
    assert.equal(r1.data.channels.instagram, 'publicado');
    assert.match(r1.data.channels.whatsapp, /Fila/);
    const photo = opts.shopee.tg.sent.find((m) => m.method === 'sendPhoto' && m.caption);
    assert.ok(photo, 'Telegram recebeu foto com legenda');
    assert.match(photo.caption, /<b>/);
    const q = (await api('GET', '/api/queue')).data.items;
    assert.ok(q.find((i) => i.channel === 'whatsapp' && i.automation_id === id && i.status === 'draft' && i.product_id === a.id));
    assert.ok(q.find((i) => i.channel === 'instagram' && i.automation_id === id && i.status === 'posted'));

    // logo em seguida: espera 20 s
    assert.equal((await api('POST', `/api/automations/${id}/run`)).status, 429);

    // rodada 2 (agendador, uma hora depois): nada novo (não repete), registra o motivo
    await t.pool.query(`update automations set last_run_at = $1`, [new Date(Date.now() - 2 * 3600e3).toISOString()]);
    const res = await runDue({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl, log: { log() {}, error() {} } });
    assert.equal(res.length, 1);
    assert.equal(res[0].status, 'empty');
    // ainda no ritmo: não roda de novo
    assert.equal((await runDue({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl, log: { log() {}, error() {} } })).length, 0);

    // nova oferta: Instagram bloqueado pelo limite diário (1), Telegram e WhatsApp seguem
    await mk({ title: 'Mixer Top', marketplace: 'SH', affiliate_url: 'https://s.shopee.com.br/mx' });
    await t.pool.query(`update automations set last_run_at = $1`, [new Date(Date.now() - 2 * 3600e3).toISOString()]);
    const [r3] = await runDue({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl, log: { log() {}, error() {} } });
    assert.equal(r3.title, 'Mixer Top');
    assert.match(r3.channels.instagram, /limite diário/);
    assert.equal(r3.channels.telegram, 'enviado');

    // pausado: não roda
    await api('PATCH', `/api/automations/${id}`, { active: false });
    await t.pool.query(`update automations set last_run_at = null`);
    assert.equal((await runDue({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl, log: { log() {}, error() {} } })).length, 0);

    const runs = await api('GET', `/api/automations/${id}/runs`);
    assert.equal(runs.data.items.length, 3);
    const list = await api('GET', '/api/automations');
    assert.equal(list.data.items[0].sent_total, 2);

    // outro usuário não vê nem roda
    const other = t.client();
    await signup(other, 'b@exemplo.com');
    assert.equal((await other('POST', `/api/automations/${id}/run`)).status, 404);
    assert.equal((await other('GET', '/api/automations')).data.items.length, 0);
  } finally { t.close(); }
});

test('planilha da Shopee completa produto já salvo (comissão, vendas, link) sem mexer na comissão digitada', async () => {
  const t = await boot({}, { ml: {} });
  try {
    const api = t.client();
    await signup(api);
    const porLink = (await api('POST', '/api/products', { title: 'Power Bank', marketplace: 'SH', price: 31.99, product_url: 'https://shopee.com.br/product/408715442/22499247158' })).data.product;
    const digitada = (await api('POST', '/api/products', { title: 'Shorts', marketplace: 'SH', price: 35, commission_pct: 5, affiliate_url: 'https://s.shopee.com.br/meu', product_url: 'https://shopee.com.br/product/1163397054/23394849645' })).data.product;
    const csv = [
      'Item Id,Item Name,Price,Sales,Nome da loja,Commission Rate,Commission,Product Link,Offer Link',
      '22499247158,Carregador Power Bank,"31,99",10mil+,SHR,28%,"R$8,96",https://shopee.com.br/product/408715442/22499247158,https://s.shopee.com.br/5LCczJBazQ',
      '23394849645,Shorts Tactel,"35,00",66,F&A,13%,"R$4,55",https://shopee.com.br/product/1163397054/23394849645,https://s.shopee.com.br/5VW3BcAxeT',
    ].join('\n');
    const r = await api('POST', '/api/garimpo/from-shopee-csv', csv);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.updated, 2);
    const list = (await api('GET', '/api/products')).data.products;
    const a = list.find((p) => p.id === porLink.id);
    assert.deepEqual([a.commission_pct, a.sales_k, a.affiliate_url], [28, 10, 'https://s.shopee.com.br/5LCczJBazQ']);
    const b = list.find((p) => p.id === digitada.id);
    assert.deepEqual([b.commission_pct, b.affiliate_url, b.sales_k], [5, 'https://s.shopee.com.br/meu', 0.066], 'comissão e link do usuário ficam');
    // de novo: nada a atualizar
    assert.equal((await api('POST', '/api/garimpo/from-shopee-csv', csv)).data.updated, 0);
  } finally { t.close(); }
});

test('Instagram: foto fora da proporção (muito larga ou comprida) vai com bordas brancas por endereço assinado', async () => {
  const sharp = require('sharp');
  const img = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const opts = { ml: { imgs: { '/larga.jpg': await img(500, 213), '/comprida.jpg': await img(390, 500), '/ok.jpg': await img(500, 500) } }, meta: {} };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    const r = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Teste proporção', media_type: 'carousel',
      media_items: ['ok', 'larga', 'comprida'].map((n) => ({ type: 'image', url: `https://http2.mlstatic.com/${n}.jpg` })) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const sent = t.calls.filter((c) => c.body && c.body.is_carousel_item).map((c) => c.body.image_url);
    assert.equal(sent[0], 'https://http2.mlstatic.com/ok.jpg', 'foto boa vai como está');
    assert.match(sent[1], /^https:\/\/app\.exemplo\.com\/api\/img\/fit\?u=.*larga.*&s=[0-9a-f]{32}$/);
    assert.match(sent[2], /comprida/);

    // o endereço ajustado entrega JPEG dentro da proporção; sem assinatura válida, recusa
    const path = sent[1].replace('https://app.exemplo.com', '');
    const base = `http://127.0.0.1:${t.server.address().port}`;
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.ok(meta.width / meta.height <= 1.91 && meta.width / meta.height >= 1.85, `${meta.width}x${meta.height}`);
    const tall = await sharp(Buffer.from(await (await fetch(base + sent[2].replace('https://app.exemplo.com', ''))).arrayBuffer())).metadata();
    assert.ok(Math.abs(tall.width / tall.height - 0.8) < 0.01, `${tall.width}x${tall.height}`);
    assert.equal((await fetch(base + path.replace(/s=[0-9a-f]+/, 's=' + '0'.repeat(32)))).status, 403);
    assert.equal((await fetch(`${base}/api/img/fit?u=${encodeURIComponent('https://evil.example.com/x.jpg')}&s=abc`)).status, 403);
  } finally { t.close(); }
});

test('fotos extras coladas no produto viram a galeria (foto principal primeiro), com validação', async () => {
  const t = await boot();
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', { ...PRODUTO, marketplace: 'SH', images: 'https://down-br.img.susercontent.com/file/b\nhttps://down-br.img.susercontent.com/file/c' })).data.product;
    assert.deepEqual(p.images, [PRODUTO.image_url, 'https://down-br.img.susercontent.com/file/b', 'https://down-br.img.susercontent.com/file/c']);
    const e = await api('PATCH', `/api/products/${p.id}`, { images: 'http://inseguro.com/x.jpg' });
    assert.equal(e.status, 400);
    const u = await api('PATCH', `/api/products/${p.id}`, { images: 'https://down-br.img.susercontent.com/file/d, https://down-br.img.susercontent.com/file/d' });
    assert.equal(u.status, 200, JSON.stringify(u.data));
    assert.deepEqual(u.data.product.images, [PRODUTO.image_url, 'https://down-br.img.susercontent.com/file/d']);
    // salvar o produto sem mexer nas fotos mantém a galeria
    const k = await api('PATCH', `/api/products/${p.id}`, { title: 'Novo nome' });
    assert.equal(k.data.product.images.length, 2);
  } finally { t.close(); }
});

test('foto que a Meta ainda está preparando ("Media ID is not available"): espera ficar pronta e publica', async () => {
  const opts = { meta: { notReady: 1 } };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', { ...PRODUTO, sales_k: 0.008 })).data.product;
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    const r = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Foto grande', media_type: 'image', media_url: PRODUTO.image_url });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.item.status, 'posted');
    assert.equal(t.calls.filter((c) => c.path.endsWith('/media_publish')).length, 2, 'tentou de novo depois de pronto');
    // poucas vendas não viram "mais de 0 mil vendidos"
    const prev = await api('POST', '/api/queue/preview', { product_id: p.id, channel: 'whatsapp' });
    assert.doesNotMatch(prev.data.caption, /0 mil vendidos/);
  } finally { t.close(); }
});

test('foto WEBP (ex.: endereço copiado da Shopee) é convertida para JPEG; colar remove o "@resize...webp"', async () => {
  const sharp = require('sharp');
  const webp = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#aa3366' } }).webp().toBuffer();
  const opts = { ml: { imgs: { '/foto.webp': webp } }, meta: {} };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', { ...PRODUTO, images: 'https://down-br.img.susercontent.com/file/br-abc@resize_w900_nl.webp' })).data.product;
    assert.deepEqual(p.images, [PRODUTO.image_url, 'https://down-br.img.susercontent.com/file/br-abc']);
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    const r = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Webp', media_type: 'image', media_url: 'https://http2.mlstatic.com/foto.webp' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const sent = t.calls.find((c) => c.body && c.body.image_url).body.image_url;
    assert.match(sent, /\/api\/img\/fit\?u=.*foto\.webp/);
    const res = await fetch(`http://127.0.0.1:${t.server.address().port}` + sent.replace('https://app.exemplo.com', ''));
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 600, 600]);
    // endereço de fora das lojas com extensão errada continua recusado
    const bad = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'x', media_type: 'image', media_url: 'https://img.exemplo.com/a.png' });
    assert.equal(bad.status, 400);
  } finally { t.close(); }
});

test('Meta não baixa uma foto do carrossel na hora: tenta de novo; se insistir, diz qual foto falhou', async () => {
  const opts = { meta: { fetchFail: 1 } };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    const items = [{ type: 'image', url: 'https://img.exemplo.com/1.jpg' }, { type: 'image', url: 'https://img.exemplo.com/2.jpg' }];
    const ok = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Carrossel', media_type: 'carousel', media_items: items });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.item.status, 'posted');

    opts.meta.fetchFail = 3; // falha na 1ª foto e na nova tentativa
    const bad = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Outro', media_type: 'carousel', media_items: items });
    assert.equal(bad.status, 502);
    assert.match(bad.data.error, /Foto 1 do carrossel: Only photo or video/);
  } finally { t.close(); }
});

test('carrossel: Meta responde id "0" (foto ainda preparando) — confere os itens e monta de novo, sem consultar "/0"', async () => {
  const opts = { meta: { carouselZero: 1 } };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;
    await api('PUT', '/api/connections/instagram', { ig_user_id: '17841400000000000', access_token: TOKEN });
    const r = await api('POST', '/api/queue/post-now', { product_id: p.id, channel: 'instagram', caption: 'Carrossel zero', media_type: 'carousel',
      media_items: [{ type: 'image', url: 'https://img.exemplo.com/1.jpg' }, { type: 'image', url: 'https://img.exemplo.com/2.jpg' }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.item.status, 'posted');
    assert.equal(t.calls.filter((c) => /\/0$/.test(c.path)).length, 0, 'nunca consulta o container "0"');
    assert.ok(t.calls.some((c) => /\/CHILD_\d+$/.test(c.path)), 'conferiu as fotos antes de montar de novo');
  } finally { t.close(); }
});

test('cupons: lê mensagem colada (sem pegar o link de outra pessoa), salva, mensagem do dia, entra na oferta e posta sozinho', async () => {
  const opts = { shopee: {} };
  const t = await boot({}, opts);
  try {
    const api = t.client();
    await signup(api);
    const msg = '10% OFF com MELHORDEHJ\nCompra mínima R$ 149\nLimite de R$ 200\nVence hoje!\n🚨 CUPOM MERCADO LIVRE 🚨\n🎟️ CUPOMON\n📍 30% em R$1, limite R$500\n🎟️ MELHORDEHJ\n📍 10% em R$149, limite R$200\n🔗 ATIVE AQUI: https://mercadolivre.com/sec/DEOUTRAPESSOA';
    const parsed = (await api('POST', '/api/coupons/parse', { text: msg })).data.items;
    assert.deepEqual(parsed.map((c) => [c.code, c.amount, c.min_purchase, c.max_discount]), [['MELHORDEHJ', 10, 149, 200], ['CUPOMON', 30, null, 500]]);
    assert.ok(parsed.every((c) => !c.link), 'não aproveita o link de afiliado de outra pessoa');

    // link precisa ser de loja
    assert.equal((await api('POST', '/api/coupons', { items: [{ ...parsed[1], link: 'https://evil.example.com/x' }] })).status, 400);
    const meu = 'https://mercadolivre.com/sec/MEULINK';
    const saved = await api('POST', '/api/coupons', { items: parsed.map((c) => ({ ...c, link: meu })) });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    assert.equal(saved.data.created, 2);
    // repetir o mesmo código atualiza
    assert.equal((await api('POST', '/api/coupons', { items: [{ ...parsed[1], amount: 35, link: meu }] })).data.updated, 1);
    // um vencido não entra na mensagem
    await api('POST', '/api/coupons', { marketplace: 'ML', code: 'VELHO10', amount: 10, expires_on: '2020-01-01', link: meu });

    const list = (await api('GET', '/api/coupons')).data.items;
    assert.equal(list.find((c) => c.code === 'VELHO10').status, 'vencido');
    const m = (await api('GET', '/api/coupons/message?channel=whatsapp')).data;
    assert.equal(m.count, 2);
    assert.match(m.text, /\*CUPONS MERCADO LIVRE\*/);
    assert.match(m.text, /\*CUPOMON\*\n📍 35% OFF sem valor mínimo, limite de R\$\s500/);
    assert.match(m.text, /ATIVE AQUI:\* https:\/\/mercadolivre\.com\/sec\/MEULINK/);
    assert.doesNotMatch(m.text, /VELHO10|DEOUTRAPESSOA/);

    // oferta do Mercado Livre de R$ 189,90: entra o melhor cupom que vale para o preço
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;
    const prev = (await api('POST', '/api/queue/preview', { product_id: p.id, channel: 'whatsapp' })).data.caption;
    assert.match(prev, /🎟️ Cupom \*CUPOMON\*: 35% OFF/);
    // Shopee: nenhum cupom da loja, nenhuma linha
    const sh = (await api('POST', '/api/products', { ...PRODUTO, title: 'Outro', marketplace: 'SH', affiliate_url: 'https://s.shopee.com.br/z' })).data.product;
    assert.doesNotMatch((await api('POST', '/api/queue/preview', { product_id: sh.id, channel: 'instagram' })).data.caption, /Cupom/);

    // automático: Telegram + Fila do WhatsApp, uma vez por dia
    await api('PUT', '/api/connections/telegram', { token: '123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789' });
    await api('PUT', '/api/connections/telegram/chat', { chat_id: '-1001234567890' });
    assert.equal((await api('PUT', '/api/coupons/settings', { auto: true, time: '00:00', channels: { telegram: true, whatsapp: true } })).status, 200);
    const { runCouponsDaily } = require('../src/routes/coupons');
    const quiet = { log() {}, error() {} };
    assert.equal(await runCouponsDaily({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl, log: quiet }), 1);
    assert.equal(await runCouponsDaily({ pool: t.pool, cfg: t.cfg, fetchImpl: t.fetchImpl, log: quiet }), 0, 'não repete no mesmo dia');
    const tgMsg = opts.shopee.tg.sent.filter((x) => x.method === 'sendMessage').pop();
    assert.match(tgMsg.text, /<b>CUPONS MERCADO LIVRE<\/b>/);
    const q = (await api('GET', '/api/queue')).data.items.find((i) => i.kind === 'coupons');
    assert.ok(q && q.channel === 'whatsapp' && q.status === 'draft');

    // outro usuário não vê
    const other = t.client();
    await signup(other, 'b@exemplo.com');
    assert.equal((await other('GET', '/api/coupons')).data.items.length, 0);
    assert.equal((await api('POST', '/api/coupons/clean')).data.removed, 1);
  } finally { t.close(); }
});

test('link comum da página da Shopee: explica que precisa do link de afiliado (s.shopee.com.br)', async () => {
  const t = await boot();
  try {
    const api = t.client();
    await signup(api);
    const r = await api('POST', '/api/garimpo/from-links', { links: ['https://shopee.com.br/Principia-Serum-Facial-i.1613313673.58266270841'] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const [it] = r.data.items;
    assert.equal(it.external_id, '1613313673.58266270841');
    assert.match(it.error, /link comum.*s\.shopee\.com\.br/);
  } finally { t.close(); }
});

test('convite para seguir o perfil: @ no Instagram (antes das hashtags) e link no WhatsApp, sem repetir', async () => {
  const t = await boot();
  try {
    const api = t.client();
    await signup(api);
    await api('PUT', '/api/auth/brand', { color: '#E8457A', handle: '@anninhaachadinhospraticos' });
    const p = (await api('POST', '/api/products', PRODUTO)).data.product;
    const ig = (await api('POST', '/api/queue/preview', { product_id: p.id, channel: 'instagram' })).data.caption;
    assert.match(ig, /💖 Segue @anninhaachadinhospraticos pra não perder nenhum achadinho!\n\n#/);
    const wa = (await api('POST', '/api/queue/preview', { product_id: p.id, channel: 'whatsapp' })).data.caption;
    assert.match(wa, /📲 Segue a gente no Instagram: https:\/\/www\.instagram\.com\/anninhaachadinhospraticos\/$/);
    assert.equal(wa.split('anninhaachadinhospraticos').length - 1, 1, 'só uma vez');
  } finally { t.close(); }
});
