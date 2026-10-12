# Garimpo

Painel para afiliados do Mercado Livre e da Shopee: cadastrar produtos campeões, classificar por prioridade, preparar e publicar as postagens e acompanhar as comissões.

Pensado para **Git + Vercel + Supabase**. Também roda em servidor próprio com Docker (veja o fim).

## O que já funciona

- **Contas e login** (e-mail e senha, sessão por cookie). Cada conta só enxerga os próprios dados.
- **Produtos** com preço, desconto, comissão, avaliação, vendas, foto e vídeo. Cadastro manual ou importação de CSV. A **nota de prioridade** (0 a 100) pesa 30% desconto, 30% comissão, 20% avaliação e 20% vendas.
- **Fila de divulgação** para Instagram e WhatsApp: texto gerado a partir dos dados do produto (ou por IA, se configurar a chave), edição, troca de foto/vídeo, agendamento e marcação de postado.
- **Publicação no Instagram** pela API oficial da Meta: foto na hora; Reels em duas etapas (o Instagram processa o vídeo e o painel conclui a publicação sozinho). Imediata ou agendada.
- **Ganhos**: lançamentos manuais ou importação de CSV, com resumo por dia, canal e produto, valor a receber e já recebido.
- **Segurança**: Postgres com RLS ligado, token do Instagram criptografado (AES-256-GCM), mídia enviada direto do navegador para o Supabase Storage.

## O que ainda não existe

- Busca automática de produtos e importação automática de comissões nas plataformas (próxima etapa: API de afiliados da Shopee; no Mercado Livre pode ser preciso importar o relatório por CSV).
- Envio automático para o WhatsApp. O painel prepara o texto e você copia e cola no grupo.
- Recuperação de senha por e-mail e vários usuários por conta.

## Publicar: Git, Supabase e Vercel

### 1. Supabase

1. Crie um projeto em supabase.com e guarde a senha do banco.
2. Em **Project Settings > API**, copie a **URL do projeto**, a chave **anon** e a chave **service_role**. A service_role é secreta: ela só vai para as variáveis da Vercel, nunca para o código.
3. No botão **Connect**, copie duas strings de conexão do Postgres: a **direta** (porta 5432) e a do **Transaction pooler** (porta 6543). Confira no painel se os endereços estão como no `.env.example`.
4. No seu computador, aplique as migrações (cria as tabelas e liga o RLS):
   ```bash
   npm install
   MIGRATE_DATABASE_URL="<string direta, porta 5432>" npm run migrate
   ```
5. No **SQL Editor** do Supabase, rode o conteúdo de `supabase/setup.sql`. Ele cria o bucket público `midia` (só JPEG, PNG e MP4, até 100 MB) e tira o acesso das chaves públicas às tabelas.

### 2. Git

```bash
git remote add origin git@github.com:SEU-USUARIO/garimpo.git
git push -u origin main
```

O `.gitignore` já exclui `.env` e `node_modules`. Nunca suba segredos.

### 3. Vercel

1. **Add New > Project** e importe o repositório. Deixe o framework como "Other"; o `vercel.json` já configura tudo.
2. Em **Environment Variables**, cadastre (valores no `.env.example`):
   `DATABASE_URL` (Transaction pooler), `JWT_SECRET`, `ENCRYPTION_KEY`, `APP_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` e, se quiser, `ANTHROPIC_API_KEY`.
3. Faça o deploy. Quando souber o domínio final, ajuste `APP_URL` e publique de novo.
4. Abra o endereço, crie a sua conta e depois coloque `ALLOW_SIGNUP=false` e republique para fechar o cadastro.

**Guarde a `ENCRYPTION_KEY`.** Se ela mudar, o token do Instagram salvo deixa de abrir e é preciso reconectar.

### 4. Agendamento das postagens

Na Vercel não existe processo rodando em segundo plano, então algo precisa chamar `/api/cron/tick` periodicamente (ele publica o que venceu e conclui os Reels em processamento). Escolha uma opção:

- **Supabase pg_cron (a cada minuto):** ative as extensões `pg_cron` e `pg_net`, e rode o bloco comentado no fim de `supabase/setup.sql`, trocando o domínio e o `CRON_SECRET`.
- **Vercel Cron:** adicione ao `vercel.json` um bloco `"crons": [{ "path": "/api/cron/tick", "schedule": "*/5 * * * *" }]`. A Vercel envia o `CRON_SECRET` sozinha. Confira na documentação da Vercel qual frequência o seu plano permite; em planos gratuitos ela costuma ser bem limitada.

Sem nenhum agendador, o resto funciona: o botão **Publicar agora** publica na hora, e a tela da Fila confere os Reels em processamento enquanto estiver aberta.

## Conectar o Instagram

A publicação usa a API oficial da Meta e exige:

1. Conta do Instagram **profissional** (comercial ou criador).
2. Um app em developers.facebook.com com o produto Instagram e a permissão de publicação de conteúdo para a sua conta. Guia oficial: https://developers.facebook.com/docs/instagram-platform/content-publishing
3. O **ID da conta** e um **token de acesso**. Cole os dois na aba **Conexões**. O painel testa as credenciais na Meta antes de salvar.

Regras que o painel já valida antes de enviar: foto só em JPEG, até 2.200 caracteres e 30 hashtags, e mídia em URL pública. Tokens expiram: se a publicação falhar por credencial, gere um novo e atualize na aba Conexões. O limite diário de publicações segue as regras da Meta.

## CSV de importação

Aceita `;` ou `,` como separador e vírgula decimal.

- Produtos: `titulo;marketplace;categoria;preco;preco_original;avaliacao;vendas_mil;comissao;link;link_afiliado;imagem;video` (marketplace: `ML` ou `SH`)
- Ganhos: `data;produto;canal;cliques;pedidos;comissao;situacao` (data em dd/mm/aaaa; canal: instagram, whatsapp ou outro; situação: pendente, confirmada ou paga)

## O que foi e o que não foi testado

Testado (21 testes automatizados, em Postgres simulado e em Postgres real): contas, isolamento entre usuários, produtos, importações, fila, ganhos, upload local, agendador, Reels em duas etapas, endpoint de cron, URL assinada de envio (com o Supabase simulado) e RLS. A entrada da Vercel (`api/index.js`) foi exercitada em modo produção.

**Não testado com contas reais:** a publicação no Instagram (só com respostas simuladas da Meta), o envio ao Supabase Storage pelo navegador, o deploy na Vercel (`vercel.json`) e o pg_cron. Faça o primeiro teste com um post descartável e confira cada etapa.

## Segurança

- Senhas com bcrypt; cookie `HttpOnly`, `Secure` em produção e `SameSite=Lax`; verificação de origem em pedidos que alteram dados; limite de tentativas de login (em memória, por instância); CSP e cabeçalhos de segurança.
- RLS ligado em todas as tabelas e acesso das chaves públicas do Supabase revogado: os dados só passam pelo servidor.
- Bucket restrito a JPEG, PNG e MP4. O app valida o tipo e o tamanho antes de liberar o envio.
- Token da Meta criptografado no banco e removido das mensagens de erro. O endpoint de cron compara a senha em tempo constante.
- Quem tem a `SUPABASE_SERVICE_ROLE_KEY` tem acesso total ao projeto. Mantenha-a só nas variáveis da Vercel.

## Rodar em servidor próprio (Docker)

```bash
cp .env.example .env     # preencha DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, APP_URL
docker compose up -d
```

Sem as variáveis do Supabase, as mídias ficam em disco (`UPLOAD_DIR`, volume `uploads`) e o agendador roda dentro do servidor, sem precisar do cron. Rode uma única instância.

## Desenvolvimento

```bash
npm test                                   # Postgres simulado em memória
PGURL=postgres://... npm test              # Postgres real (APAGA o schema public!)
npm start                                  # exige DATABASE_URL
```

```
api/index.js           entrada da Vercel
src/server.js          aplicação e inicialização local
src/routes/            auth, products, queue, media, earnings, connections, cron
src/services/          score, copy, instagram, publisher (publicação e agendador), storage
migrations/            SQL versionado (npm run migrate)
supabase/setup.sql     bucket, permissões e agendamento (rodar uma vez)
public/                interface web
test/                  testes de API
```
