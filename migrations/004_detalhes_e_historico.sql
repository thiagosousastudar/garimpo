alter table products add column extras text;

create table price_history (
  id serial primary key,
  product_id integer not null references products(id) on delete cascade,
  price numeric(12,2) not null,
  original_price numeric(12,2),
  checked_at timestamptz not null default now()
);

create index price_history_product_idx on price_history (product_id, checked_at);

insert into price_history (product_id, price, original_price, checked_at)
  select id, price, original_price, coalesce(price_checked_at, created_at) from products;

alter table price_history enable row level security;
