-- Automação por post (Direct): palavra-gatilho, respostas ao comentário, texto do Direct e produtos de cada post.
create table post_automations (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  media_id text not null,
  permalink text,
  thumb_url text,
  caption text,
  keywords text not null default '',
  replies text,
  dm_text text,
  button_text text,
  items text not null default '[]',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index post_automations_uniq on post_automations (user_id, media_id);

-- avisos no Telegram (chat privado com o bot): "comentaram pedindo o link num post sem automação"
alter table connections add column tg_alert_chat_id text;

alter table ig_media_seen add column alerted_at timestamptz;

alter table post_automations enable row level security;
