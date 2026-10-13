create table coupons (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  marketplace text not null,
  code text not null,
  kind text not null default 'percent',
  amount numeric(10,2) not null,
  min_purchase numeric(10,2),
  max_discount numeric(10,2),
  expires_on date,
  link text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index coupons_user_idx on coupons (user_id);

alter table users add column coupons_auto boolean not null default false;

alter table users add column coupons_time text;

alter table users add column coupons_channels text;

alter table users add column coupons_last_on date;

alter table coupons enable row level security;

alter table queue_items add column kind text;
