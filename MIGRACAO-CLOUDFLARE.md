# Migração RicServ: Netlify → Cloudflare Pages

## O que foi convertido

- `netlify/functions/*.js` → `functions/api/*.js` (convenção de rotas do Cloudflare Pages: o caminho do arquivo vira o caminho da URL).
- `exports.handler(event)` → `export async function onRequestPost({ request, env })` (ou `onRequestGet`).
- `process.env.X` → `env.X`.
- `crypto` do Node (no webhook) → Web Crypto API (`crypto.subtle`), nativa do runtime do Cloudflare.
- Chamadas do frontend em `comprar-moedas.html`: `/.netlify/functions/...` → `/api/...`.
- `netlify.toml` → `_redirects` (mesmo comportamento de fallback para SPA).

Nenhuma lógica de negócio, validação de segurança ou regra de preço foi alterada — só a "casca" de cada função.

## Passo a passo do deploy

1. **Crie um repositório Git** (GitHub/GitLab) com esta pasta, ou use o deploy direto por upload no painel do Cloudflare Pages.

2. **No painel do Cloudflare:**
   - Vá em **Workers & Pages → Create → Pages**
   - Conecte o repositório (ou faça upload direto da pasta)
   - Build command: deixe **vazio** (não há build, é HTML estático)
   - Output directory: `/` (raiz)

3. **Configure as variáveis de ambiente** em **Settings → Environment variables** (tanto em Production quanto Preview):
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (marcar como **Secret/Encrypt**)
   - `PAGBANK_TOKEN` (marcar como **Secret/Encrypt**)
   - `PAGBANK_ENV` (`sandbox` ou `production`)
   - `SITE_URL` (ex: `https://ricserv.digital`, sem barra no final — usada para montar a URL do webhook)

4. **Atualize a URL do webhook no painel do PagBank** (se estiver cadastrada manualmente lá) para:
   `https://SEU-DOMINIO/api/webhook-pagbank`

5. **Deploy.** Depois do primeiro deploy, teste:
   - `GET /api/chave-publica-cartao` → deve devolver `{ "publicKey": "..." }`
   - O fluxo de compra de moedas completo em `/comprar-moedas.html`

## Atenção

- As variáveis marcadas como "Secret" no Cloudflare não aparecem mais no painel depois de salvas — confirme os valores antes de salvar.
- Se o domínio `ricserv.digital` (ou o que for) ainda estiver com DNS na Hostinger, será preciso apontar os nameservers para o Cloudflare (ou pelo menos o registro do domínio usado no Pages) para o custom domain funcionar.
