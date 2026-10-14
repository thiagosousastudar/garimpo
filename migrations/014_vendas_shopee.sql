alter table earnings add column external_ref text;

create unique index earnings_external_idx on earnings (user_id, external_ref);

alter table users add column sh_sales_synced_at timestamptz;
