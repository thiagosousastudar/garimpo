alter table products add column external_id text;

alter table products add column price_checked_at timestamptz;

create unique index products_user_external_idx on products (user_id, marketplace, external_id);

create table marketplace_connections (
  user_id integer not null references users(id) on delete cascade,
  marketplace text not null,
  app_id text not null,
  secret_enc text not null,
  access_token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  default_commission numeric(5,2),
  updated_at timestamptz not null default now(),
  primary key (user_id, marketplace)
);

alter table marketplace_connections enable row level security;
