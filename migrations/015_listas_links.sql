-- Listas de links: produtos de um post (ex.: carrossel) para mandar a mensagem com os links a quem pedir.
create table link_lists (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  name text not null,
  items text not null default '[]',
  greeting text,
  closing text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index link_lists_user_idx on link_lists (user_id, updated_at);

alter table link_lists enable row level security;
