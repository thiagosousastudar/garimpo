/**
 * Telegram (API oficial de bots): posta ofertas em grupos e canais.
 * O usuário cria um bot no @BotFather, adiciona como administrador no grupo/canal e cola o token no Garimpo.
 */
const API = 'https://api.telegram.org';
const CAPTION_MAX = 1024; // limite de legenda de foto no Telegram

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Texto no formato do WhatsApp (*negrito*, ~riscado~, _itálico_) para o HTML do Telegram.
 * Escapa o resto para não quebrar a mensagem.
 */
function toTelegramHtml(text) {
  return escapeHtml(text)
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/~([^~\n]+)~/g, '<s>$1</s>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>');
}

function createTelegramClient({ token, fetchImpl = fetch }) {
  async function call(method, body) {
    const res = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const msg = String(data.description || `HTTP ${res.status}`).split(token).join('[token]');
      const e = new Error(`Telegram: ${msg}`);
      e.status = data.error_code || res.status;
      throw e;
    }
    return data.result;
  }

  return {
    /** Confere o token; devolve { username, first_name }. */
    me: () => call('getMe'),

    /**
     * Grupos e canais onde o bot recebeu algo recentemente (precisa ter sido adicionado e haver
     * uma mensagem/postagem depois disso). Devolve [{ id, title, type }].
     */
    /** Conversas privadas com o bot (quem mandou /start): para receber avisos só para você. */
    async privateChats() {
      const updates = await call('getUpdates', { limit: 100, allowed_updates: ['message'] });
      const by = new Map();
      for (const u of updates || []) {
        const chat = (u.message || {}).chat;
        if (chat && chat.type === 'private') by.set(String(chat.id), { id: String(chat.id), title: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id), username: chat.username || null });
      }
      return [...by.values()];
    },

    async chats() {
      const updates = await call('getUpdates', { limit: 100, allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
      const by = new Map();
      for (const u of updates || []) {
        const chat = (u.message || u.channel_post || u.my_chat_member || {}).chat;
        if (chat && chat.type !== 'private') by.set(String(chat.id), { id: String(chat.id), title: chat.title || chat.username || String(chat.id), type: chat.type });
      }
      return [...by.values()];
    },

    /** Informações do chat (para validar um @canal digitado). */
    chat: (chatId) => call('getChat', { chat_id: chatId }),

    sendMessage: (chatId, text) => call('sendMessage', { chat_id: chatId, text: toTelegramHtml(text), parse_mode: 'HTML', disable_web_page_preview: false }),

    /** Foto com o texto como legenda; se o texto passar do limite, foto e texto vão separados. */
    async sendOffer(chatId, { photo, text }) {
      const html = toTelegramHtml(text);
      if (!photo) return call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML' });
      if (html.length <= CAPTION_MAX) return call('sendPhoto', { chat_id: chatId, photo, caption: html, parse_mode: 'HTML' });
      await call('sendPhoto', { chat_id: chatId, photo });
      return call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML' });
    },
  };
}

module.exports = { createTelegramClient, toTelegramHtml };
