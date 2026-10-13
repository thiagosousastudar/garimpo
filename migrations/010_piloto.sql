create table automations (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  config text not null,
  last_run_at timestamptz,
  run_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index automations_user_idx on automations (user_id);

create table automation_runs (
  id serial primary key,
  automation_id integer not null references automations(id) on delete cascade,
  product_id integer references products(id) on delete set null,
  external_id text,
  title text,
  result text,
  ran_at timestamptz not null default now()
);

create index automation_runs_idx on automation_runs (automation_id, ran_at);

alter table queue_items add column automation_id integer;

alter table connections add column tg_token_enc text;

alter table connections add column tg_chat_id text;

alter table connections add column tg_chat_title text;

alter table automations enable row level security;

alter table automation_runs enable row level security;
