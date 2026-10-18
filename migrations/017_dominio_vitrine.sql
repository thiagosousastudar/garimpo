-- Domínio próprio da vitrine (ex.: anninhaachadinhos.com.br): o endereço abre a vitrine direto.
alter table storefronts add column domain text;

create unique index storefronts_domain_idx on storefronts (domain);
