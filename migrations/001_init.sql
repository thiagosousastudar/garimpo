create table users (
  id serial primary key,
  email text not null unique,
  password_hash text not null,
  name text,
  created_at timestamptz not null default now()
);

create table products (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  title text not null,
  marketplace text not null,
  category text,
  price numeric(12,2) not null,
  original_price numeric(12,2),
  rating numeric(3,2),
  sales_k numeric(8,2),
  commission_pct numeric(5,2),
  product_url text,
  affiliate_url text,
  image_url text,
  video_url text,
  notes text,
  created_at timestamptz not null default now()
);

create index products_user_idx on products (user_id);

create table queue_items (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  product_id integer references products(id) on delete set null,
  channel text not null,
  caption text not null,
  media_type text not null default 'none',
  media_url text,
  status text not null default 'draft',
  scheduled_at timestamptz,
  posted_at timestamptz,
  external_id text,
  permalink text,
  error text,
  created_at timestamptz not null default now()
);

create index queue_user_idx on queue_items (user_id);
create index queue_due_idx on queue_items (status, scheduled_at);

create table earnings (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  product_id integer references products(id) on delete set null,
  day date not null,
  channel text not null,
  clicks integer not null default 0,
  orders integer not null default 0,
  commission numeric(12,2) not null default 0,
  status text not null default 'pendente',
  created_at timestamptz not null default now()
);

create index earnings_user_idx on earnings (user_id, day);

create table connections (
  user_id integer primary key references users(id) on delete cascade,
  ig_user_id text,
  ig_token_enc text,
  updated_at timestamptz not null default now()
);
