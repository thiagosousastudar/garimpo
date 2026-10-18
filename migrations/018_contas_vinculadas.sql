-- Contas vinculadas: trocar de conta (ex.: perfil feminino e masculino) sem digitar a senha.
create table account_links (
  user_id integer not null references users(id) on delete cascade,
  other_id integer not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, other_id)
);

-- Tom da conta (legendas, Direct e mensagens): 'feminino' ou 'masculino'
alter table users add column voice text not null default 'feminino';

-- Etiqueta (Sub ID) nos links da Shopee, para separar as vendas de cada conta
alter table users add column sh_sub_id text;

-- Conta principal: recebe também as vendas de links sem etiqueta
alter table users add column sh_untagged boolean not null default true;

alter table account_links enable row level security;
