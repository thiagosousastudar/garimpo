/**
 * Cliente mínimo da API de publicação do Instagram (Graph API).
 * Fluxo: cria um "container" de mídia, confere o processamento (vídeo) e publica o container.
 * Requer conta profissional, app da Meta e permissão de publicação (ver README).
 */
const IG_LOGIN_BASE = 'https://graph.instagram.com';

/**
 * Tokens do "login do Instagram" (API do Instagram sem Página do Facebook) começam com "IG" e usam
 * graph.instagram.com; os do login do Facebook ("EAA...") usam graph.facebook.com. Os endpoints de
 * publicação (/media, /media_publish, status) são os mesmos nos dois.
 */
const isInstagramLoginToken = (token) => /^IG/.test(String(token || ''));

/** Data da Meta ("2026-10-12T11:26:00+0000") em milissegundos. */
const igTime = (s) => new Date(String(s || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime() || 0;

/**
 * Limite de chamadas da Meta (por app ou por usuário, janela de 1 hora): códigos 4, 17, 32, 613
 * ou mensagens "request limit reached". Repetir só piora; é preciso esperar.
 */
function isRateLimit(err, status) {
  return [4, 17, 32, 613].includes(Number(err?.code)) || /request limit|rate limit|too many calls/i.test(String(err?.message || '')) || status === 429;
}

function createInstagramClient({ cfg, fetchImpl = fetch }) {
  const baseFor = (token) => `${isInstagramLoginToken(token) ? (cfg.igLoginBase || IG_LOGIN_BASE) : cfg.graphBase}/${cfg.graphVersion}`;

  function clean(message, token) {
    let m = String(message || 'Erro desconhecido');
    if (token) m = m.split(token).join('[token]');
    return m;
  }

  async function call(method, path, params, token) {
    const url = new URL(baseFor(token) + path);
    const all = { ...params, access_token: token };
    let res;
    if (method === 'GET') {
      for (const [k, v] of Object.entries(all)) url.searchParams.set(k, String(v));
      res = await fetchImpl(url.toString(), { method: 'GET' });
    } else {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(all)) body.set(k, String(v));
      res = await fetchImpl(url.toString(), { method: 'POST', body });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const e = new Error(clean(data.error?.message || `Erro HTTP ${res.status}`, token));
      e.code = data.error?.code;
      e.rateLimited = isRateLimit(data.error, res.status);
      throw e;
    }
    return data;
  }

  return {
    /**
     * Renova um token de longa duração do login do Instagram (vale 60 dias; renovável após 24 h de emitido).
     * Devolve { token, expiresIn } ou null se o token não for desse tipo.
     */
    async refreshToken(token) {
      if (!isInstagramLoginToken(token)) return null;
      const url = new URL(`${cfg.igLoginBase || IG_LOGIN_BASE}/refresh_access_token`);
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', token);
      const res = await fetchImpl(url.toString(), { method: 'GET' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.access_token) throw new Error(clean(data.error?.message || `Erro HTTP ${res.status}`, token));
      return { token: data.access_token, expiresIn: Number(data.expires_in) || null };
    },

    /**
     * Login do Instagram (OAuth): troca o "code" por um token curto e, em seguida, por um de 60 dias.
     * Devolve { token, expiresIn }.
     */
    async exchangeCode({ code, redirectUri }) {
      const body = new URLSearchParams({ client_id: cfg.igAppId, client_secret: cfg.igAppSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code });
      const res = await fetchImpl(cfg.igOauthBase || 'https://api.instagram.com/oauth/access_token', { method: 'POST', body });
      const raw = await res.json().catch(() => ({}));
      const data = Array.isArray(raw.data) ? raw.data[0] || {} : raw;
      if (!res.ok || !data.access_token) throw new Error(clean(raw.error_message || raw.error?.message || `Erro HTTP ${res.status}`, cfg.igAppSecret));
      const url = new URL(`${cfg.igLoginBase || IG_LOGIN_BASE}/access_token`);
      url.searchParams.set('grant_type', 'ig_exchange_token');
      url.searchParams.set('client_secret', cfg.igAppSecret);
      url.searchParams.set('access_token', data.access_token);
      const res2 = await fetchImpl(url.toString(), { method: 'GET' });
      const long = await res2.json().catch(() => ({}));
      if (!res2.ok || !long.access_token) throw new Error(clean(clean(long.error?.message || `Erro HTTP ${res2.status}`, cfg.igAppSecret), data.access_token));
      return { token: long.access_token, expiresIn: Number(long.expires_in) || null };
    },

    /** Conta dona do token (login do Instagram): { user_id, username }. */
    async me(token) {
      return call('GET', '/me', { fields: 'user_id,username' }, token);
    },

    /** Confere o token e devolve o @usuário. */
    async whoami({ igUserId, token }) {
      return call('GET', `/${igUserId}`, { fields: 'username' }, token);
    },

    /**
     * Cria o container. kind: 'image' | 'video' (Reels). Devolve { id }.
     * Com carouselItem, vira um item de carrossel: sem legenda, e vídeo usa media_type VIDEO.
     */
    async createContainer({ igUserId, token, kind, mediaUrl, caption, carouselItem = false }) {
      const params = {};
      if (!carouselItem && caption !== undefined) params.caption = caption;
      if (carouselItem) params.is_carousel_item = 'true';
      if (kind === 'video') {
        params.media_type = carouselItem ? 'VIDEO' : 'REELS';
        params.video_url = mediaUrl;
      } else {
        params.image_url = mediaUrl;
      }
      return call('POST', `/${igUserId}/media`, params, token);
    },

    /** Container do carrossel a partir dos itens já criados (2 a 10). Devolve { id }. */
    async createCarousel({ igUserId, token, children, caption }) {
      const out = await call('POST', `/${igUserId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption }, token);
      // A Meta às vezes responde id "0" quando algum item ainda não está pronto: não é um container de verdade
      if (!out || !out.id || String(out.id) === '0') {
        const e = new Error('Media ID is not available (o Instagram ainda está preparando as fotos do carrossel)');
        e.code = 9007;
        throw e;
      }
      return out;
    },

    /* ---------- comentários e Direct (resposta privada a comentário) ---------- */

    /** Posts recentes do perfil: [{ id, timestamp, comments_count, permalink }]. */
    async recentMedia({ igUserId, token, limit = 10 }) {
      const d = await call('GET', `/${igUserId}/media`, { fields: 'id,timestamp,comments_count,permalink', limit }, token);
      return d.data || [];
    },

    /** Comentários de um post: [{ id, text, timestamp, username, from: { id, username } }]. */
    async comments({ mediaId, token, limit = 50 }) {
      const d = await call('GET', `/${mediaId}/comments`, { fields: 'id,text,timestamp,username,from{id,username}', limit }, token);
      return d.data || [];
    },

    /**
     * Resposta privada: manda uma mensagem no Direct de quem comentou (1 por comentário, até 7 dias depois).
     * É o recurso oficial da Meta para "comenta QUERO que eu te mando".
     */
    async privateReply({ igUserId, token, commentId, text }) {
      return call('POST', `/${igUserId}/messages`, { recipient: JSON.stringify({ comment_id: commentId }), message: JSON.stringify({ text }) }, token);
    },

    /** Resposta pública no comentário (ex.: "Te mandei no Direct!"). */
    async replyComment({ commentId, token, text }) {
      return call('POST', `/${commentId}/replies`, { message: text }, token);
    },

    /** Devolve IN_PROGRESS, FINISHED, ERROR, EXPIRED ou PUBLISHED. */
    async containerStatus({ containerId, token }) {
      const st = await call('GET', `/${containerId}`, { fields: 'status_code' }, token);
      return st.status_code;
    },

    /**
     * O container já virou post? (status PUBLISHED). Se sim, procura o post entre os mais recentes pela legenda
     * para pegar id e link. Serve para quando a Meta publica mas responde com erro (ex.: limite de chamadas).
     * Devolve { id, permalink } (podem ser null) ou null se não foi publicado.
     */
    async findPublished({ igUserId, token, containerId, caption, since }) {
      // A situação do container não é confiável depois de publicado (já vimos post no ar com container "ERROR"),
      // então o principal é procurar o post no perfil: mesma legenda, publicado depois da tentativa.
      let code = null;
      if (containerId) {
        try { code = (await call('GET', `/${containerId}`, { fields: 'status_code' }, token)).status_code; } catch (e) { if (e.rateLimited) throw e; }
      }
      const start = String(caption || '').trim().slice(0, 60);
      const after = since ? new Date(since).getTime() - 5 * 60 * 1000 : 0;
      const list = await call('GET', `/${igUserId}/media`, { fields: 'id,permalink,caption,timestamp', limit: 10 }, token);
      const hit = (list.data || []).find((m) => start && String(m.caption || '').trim().startsWith(start)
        && (!after || igTime(m.timestamp) >= after));
      if (hit) return { id: hit.id, permalink: hit.permalink || null };
      return code === 'PUBLISHED' ? { id: null, permalink: null } : null;
    },

    /** Situação com o detalhe que a Meta dá quando há erro (ex.: "Error: ... 2207026"). */
    async containerDetail({ containerId, token }) {
      const st = await call('GET', `/${containerId}`, { fields: 'status_code,status' }, token);
      return { code: st.status_code, status: st.status || null };
    },

    /** Publica um container pronto. Devolve { id, permalink }. */
    async publishContainer({ igUserId, token, containerId }) {
      const pub = await call('POST', `/${igUserId}/media_publish`, { creation_id: containerId }, token);
      let permalink = null;
      try {
        const info = await call('GET', `/${pub.id}`, { fields: 'permalink' }, token);
        permalink = info.permalink || null;
      } catch (_) { /* o post já foi publicado; o link é opcional */ }
      return { id: pub.id, permalink };
    },
  };
}

module.exports = { createInstagramClient, isInstagramLoginToken, isRateLimit };
