-- Rode UMA vez no SQL Editor do Supabase (projeto novo), depois de aplicar as migrações (npm run migrate).
-- 1) Bucket público para fotos e vídeos. O Instagram precisa abrir a mídia por URL pública.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('midia', 'midia', true, 104857600, array['image/jpeg', 'image/png', 'video/mp4'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2) As tabelas do app só devem ser acessadas pelo servidor (conexão direta ao banco).
--    Remove o acesso pela API pública do Supabase (chaves anon/authenticated).
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- 3) OPCIONAL: agendamento a cada minuto, sem depender do plano da Vercel.
--    Antes, ative as extensões pg_cron e pg_net (Database > Extensions) e troque os dois valores abaixo:
--      SEU-APP.vercel.app  ->  o domínio do app na Vercel
--      SEU_CRON_SECRET     ->  o mesmo valor da variável CRON_SECRET na Vercel
-- select cron.schedule(
--   'garimpo-tick',
--   '* * * * *',
--   $$ select net.http_post(
--        url := 'https://SEU-APP.vercel.app/api/cron/tick',
--        headers := jsonb_build_object('Authorization', 'Bearer SEU_CRON_SECRET')
--      ) $$
-- );
