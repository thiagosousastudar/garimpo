-- Vitrine (mini site da bio): página pública com categorias de produtos escolhidos e link de afiliado.
create table storefronts (
  user_id integer primary key references users(id) on delete cascade,
  slug text not null,
  title text not null default '',
  bio text,
  theme text not null default 'rosa',
  avatar_url text,
  whatsapp_url text,
  telegram_url text,
  instagram text,
  published boolean not null default false,
  views integer not null default 0,
  updated_at timestamptz not null default now()
);

create unique index storefronts_slug_idx on storefronts (slug);

create table storefront_sections (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  name text not null,
  emoji text,
  description text,
  position integer not null default 0,
  items text not null default '[]',
  created_at timestamptz not null default now()
);

create index storefront_sections_user_idx on storefront_sections (user_id, position);

-- cliques no botão do produto na vitrine e nas páginas de post
alter table products add column vitrine_clicks integer not null default 0;

alter table storefronts enable row level security;

alter table storefront_sections enable row level security;
