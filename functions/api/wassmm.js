// Cloudflare Pages Function: /api/wassmm
// A chave do WasSMM fica só nas variáveis secretas da Cloudflare (WASSMM_KEY).
// Quem chama precisa enviar o ADMIN_TOKEN. Nada disso fica escrito no repositório.

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// comparação em tempo constante, para não vazar o token por diferença de tempo
function iguais(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function chamar(env, params) {
  const url = env.WASSMM_API_URL || "https://wassmm.online/api/v2";
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: env.WASSMM_KEY, ...params }),
  });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { error: "Resposta inválida do fornecedor" };
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.WASSMM_KEY || !env.ADMIN_TOKEN) return json({ error: "Servidor não configurado" }, 500);

  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!iguais(token, env.ADMIN_TOKEN)) return json({ error: "Não autorizado" }, 401);

  let b;
  try {
    b = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  try {
    switch (b.action) {
      case "services":
        return json(await chamar(env, { action: "services" }));

      case "balance":
        return json(await chamar(env, { action: "balance" }));

      case "add": {
        const service = String(b.service || "");
        const link = String(b.link || "").trim();
        const quantity = Number(b.quantity);
        if (!/^\d{1,8}$/.test(service)) return json({ error: "Serviço inválido" }, 400);
        if (!/^https:\/\/[^\s]{4,500}$/.test(link)) return json({ error: "O link precisa começar com https://" }, 400);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000000)
          return json({ error: "Quantidade inválida" }, 400);
        return json(await chamar(env, { action: "add", service, link, quantity: String(quantity) }));
      }

      case "status": {
        const order = String(b.order || "");
        if (!/^\d{1,12}$/.test(order)) return json({ error: "Número de pedido inválido" }, 400);
        return json(await chamar(env, { action: "status", order }));
      }

      default:
        return json({ error: "Ação desconhecida" }, 400);
    }
  } catch {
    return json({ error: "Falha ao falar com o fornecedor" }, 502);
  }
}

// qualquer outro método é recusado
export const onRequest = () => json({ error: "Método não permitido" }, 405);
