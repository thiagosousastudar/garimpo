alter table queue_items add column container_id text;

alter table queue_items add column claimed_at timestamptz;

alter table users enable row level security;

alter table products enable row level security;

alter table queue_items enable row level security;

alter table earnings enable row level security;

alter table connections enable row level security;

alter table schema_migrations enable row level security;
