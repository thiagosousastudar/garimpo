/**
 * Cliente mínimo da API de publicação do Instagram (Graph API).
 * Fluxo: cria um "container" de mídia, confere o processamento (vídeo) e publica o container.
 * Requer conta profissional, app da Meta e permissão de publicação (ver README).
 */
function createInstagramClient({ cfg, fetchImpl = fetch }) {
  const base = `${cfg.graphBase}/${cfg.graphVersion}`;

  function clean(message, token) {
    let m = String(message || 'Erro desconhecido');
    if (token) m = m.split(token).join('[token]');
    return m;
  }

  async function call(method, path, params, token) {
    const url = new URL(base + path);
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
      throw new Error(clean(data.error?.message || `Erro HTTP ${res.status}`, token));
    }
    return data;
  }

  return {
    /** Confere o token e devolve o @usuário. */
    async whoami({ igUserId, token }) {
      return call('GET', `/${igUserId}`, { fields: 'username' }, token);
    },

    /** Cria o container. kind: 'image' | 'video' (Reels). Devolve { id }. */
    async createContainer({ igUserId, token, kind, mediaUrl, caption }) {
      const params = { caption };
      if (kind === 'video') {
        params.media_type = 'REELS';
        params.video_url = mediaUrl;
      } else {
        params.image_url = mediaUrl;
      }
      return call('POST', `/${igUserId}/media`, params, token);
    },

    /** Devolve IN_PROGRESS, FINISHED, ERROR, EXPIRED ou PUBLISHED. */
    async containerStatus({ containerId, token }) {
      const st = await call('GET', `/${containerId}`, { fields: 'status_code' }, token);
      return st.status_code;
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

module.exports = { createInstagramClient };
