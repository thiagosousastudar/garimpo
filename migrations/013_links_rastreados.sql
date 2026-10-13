create table tracked_links (
  id serial primary key,
  code text not null,
  user_id integer not null references users(id) on delete cascade,
  product_id integer references products(id) on delete set null,
  ig_comment_id integer references ig_comments(id) on delete set null,
  channel text not null default 'direct',
  target_url text not null,
  clicks integer not null default 0,
  first_click_at timestamptz,
  last_click_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index tracked_links_code_idx on tracked_links (code);

create index tracked_links_user_idx on tracked_links (user_id, created_at);

alter table users add column dm_track_links boolean not null default true;

alter table tracked_links enable row level security;
