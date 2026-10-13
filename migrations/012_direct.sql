create table ig_comments (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  comment_id text not null,
  media_id text not null,
  queue_item_id integer references queue_items(id) on delete set null,
  username text,
  text text,
  commented_at timestamptz,
  matched boolean not null default false,
  status text not null default 'novo',
  reply_text text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index ig_comments_uniq on ig_comments (user_id, comment_id);

create index ig_comments_user_idx on ig_comments (user_id, created_at);

create table ig_media_seen (
  user_id integer not null references users(id) on delete cascade,
  media_id text not null,
  comments_count integer not null default 0,
  checked_at timestamptz not null default now(),
  primary key (user_id, media_id)
);

alter table users add column dm_auto boolean not null default false;

alter table users add column dm_keywords text;

alter table users add column dm_template text;

alter table users add column dm_public_reply boolean not null default true;

alter table users add column dm_synced_at timestamptz;

alter table ig_comments enable row level security;

alter table ig_media_seen enable row level security;
