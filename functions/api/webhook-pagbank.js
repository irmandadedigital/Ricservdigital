// functions/api/webhook-pagbank.js
//
// Recebe a notificação de pagamento do PagBank (API de Pedidos, PIX).
//
// Segurança em duas camadas, pra ninguém conseguir fingir um pagamento:
//   1) Confirmação de autenticidade oficial do PagBank: recalcula
//      SHA256(token_da_conta + "-" + corpo_bruto_da_requisicao) e compara
//      com o header x-authenticity-token.
//   2) Mesmo com a assinatura batendo, NUNCA confiamos apenas no "status"
//      que veio dentro do corpo da notificação: fazemos um GET direto no
//      pedido na API do PagBank e só creditamos moedas se o PagBank
//      confirmar, na hora, que o status é PAID.
//
// Também é idempotente: se o PagBank reenviar a mesma notificação, a
// solicitação já vai estar com status 'pago' e nada é creditado de novo.

async function calcularAssinatura(token, payloadCru) {
  const encoder = new TextEncoder();
  const dados = encoder.encode(`${token}-${payloadCru}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dados);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Comparação em tempo constante, pra evitar timing attack na validação do hash.
function assinaturasIguais(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let resultado = 0;
  for (let i = 0; i < a.length; i++) {
    resultado |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return resultado === 0;
}

async function buscarSolicitacaoPorOrderId(env, orderId) {
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/solicitacoes_moedas?pagbank_order_id=eq.${orderId}&select=*`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  const rows = await resp.json();
  return rows[0] || null;
}

async function marcarComoPago(env, id) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/solicitacoes_moedas?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'pago', pago_em: new Date().toISOString() }),
  });
}

async function creditarMoedas(env, profissionalId, quantidade) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/credit_moedas`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_profissional_id: profissionalId, p_quantidade: quantidade }),
  });
  if (!resp.ok) {
    const erro = await resp.text();
    throw new Error(`Falha ao creditar moedas: ${erro}`);
  }
}

export async function onRequestPost({ request, env }) {
  const PAGBANK_ENV = env.PAGBANK_ENV || 'sandbox';
  const PAGBANK_BASE_URL =
    PAGBANK_ENV === 'production'
      ? 'https://api.pagseguro.com'
      : 'https://sandbox.api.pagseguro.com';

  // IMPORTANTE: usar o corpo cru exatamente como chegou, sem re-serializar,
  // senão o hash nunca vai bater com o header.
  const payloadCru = await request.text();

  const headerRecebido = request.headers.get('x-authenticity-token');

  if (!env.PAGBANK_TOKEN) {
    console.error('PAGBANK_TOKEN não configurado no ambiente');
    return new Response('Configuração ausente', { status: 500 });
  }

  if (!headerRecebido) {
    console.warn('Notificação recebida sem x-authenticity-token — descartada');
    return new Response('Assinatura ausente', { status: 401 });
  }

  const assinaturaEsperada = await calcularAssinatura(env.PAGBANK_TOKEN, payloadCru);
  if (!assinaturasIguais(assinaturaEsperada, headerRecebido)) {
    console.warn('Notificação com assinatura inválida — descartada');
    return new Response('Assinatura inválida', { status: 401 });
  }

  let notificacao;
  try {
    notificacao = JSON.parse(payloadCru);
  } catch {
    return new Response('JSON inválido', { status: 400 });
  }

  const orderId = notificacao.id;
  if (!orderId) {
    return new Response('Notificação sem id de pedido', { status: 400 });
  }

  // Camada 2: nunca confiar só no status do corpo. Confirmar direto na API.
  let pedidoConfirmado;
  try {
    const resp = await fetch(`${PAGBANK_BASE_URL}/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${env.PAGBANK_TOKEN}`, Accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`GET /orders/${orderId} retornou ${resp.status}`);
    pedidoConfirmado = await resp.json();
  } catch (e) {
    console.error('Falha ao confirmar pedido direto no PagBank', e);
    return new Response('Falha ao confirmar pedido', { status: 500 });
  }

  const chargeConfirmada = pedidoConfirmado.charges && pedidoConfirmado.charges[0];
  if (!chargeConfirmada || chargeConfirmada.status !== 'PAID') {
    return new Response('OK - nada a creditar', { status: 200 });
  }

  const solicitacao = await buscarSolicitacaoPorOrderId(env, orderId);
  if (!solicitacao) {
    console.error('Pedido pago sem solicitacao_moedas correspondente', orderId);
    return new Response('OK - solicitacao nao encontrada', { status: 200 });
  }

  if (solicitacao.status === 'pago') {
    return new Response('OK - ja processado', { status: 200 });
  }

  try {
    await creditarMoedas(env, solicitacao.profissional_id, solicitacao.quantidade);
    await marcarComoPago(env, solicitacao.id);
  } catch (e) {
    console.error('Erro ao creditar moedas', e);
    return new Response('Falha ao creditar moedas', { status: 500 });
  }

  return new Response('OK', { status: 200 });
      }
