/**
 * Armazenamento de fotos e vídeos.
 *  - supabase: o navegador envia direto para o Supabase Storage com uma URL assinada (sem passar pelo servidor,
 *    que na Vercel tem limite de tamanho de requisição). O bucket precisa ser público para o Instagram ler a mídia.
 *  - local: grava em disco (desenvolvimento e servidor próprio).
 */
function createStorage(cfg, { createClient } = {}) {
  if (!cfg.supabaseUrl || !cfg.supabaseServiceKey) return { driver: 'local' };
  const make = createClient || require('@supabase/supabase-js').createClient;
  const sb = make(cfg.supabaseUrl, cfg.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    driver: 'supabase',
    async sign(path) {
      const { data, error } = await sb.storage.from(cfg.supabaseBucket).createSignedUploadUrl(path);
      if (error) throw new Error(error.message);
      return { token: data.token, path: data.path || path };
    },
    publicUrl(path) {
      return `${cfg.supabaseUrl}/storage/v1/object/public/${cfg.supabaseBucket}/${path}`;
    },
  };
}

module.exports = { createStorage };
