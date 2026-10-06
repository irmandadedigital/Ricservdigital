// functions/api/webhook-infinitepay.js
//
// Recebe a notificação de pagamento da InfinitePay.
//
// A InfinitePay não documenta uma assinatura de segurança pro webhook, então
// NUNCA confiamos apenas no corpo que chegou aqui: confirmamos o pagamento
// direto na API deles (POST /payment_check) antes de creditar qualquer
// moeda. Também confere se o valor pago bate com o valor esperado.
//
// Idempotente: se a InfinitePay reenviar a mesma notificação, a solicitação
// já vai estar 'pago' e nada é creditado de novo.

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function buscarSolicitacaoPorReferencia(env, referenciaId) {
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/solicitacoes_moedas?referencia_id=eq.${encodeURIComponent(referenciaId)}&select=*`,
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
  if (!env.INFINITEPAY_HANDLE || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Variáveis de ambiente faltando no webhook-infinitepay');
    return new Response('Configuração ausente', { status: 500 });
  }

  let notificacao;
  try {
    notificacao = await request.json();
  } catch {
    return new Response('JSON inválido', { status: 400 });
  }

  const orderNsu = notificacao.order_nsu;
  const invoiceSlug = notificacao.invoice_slug;
  const transactionNsu = notificacao.transaction_nsu;

  if (!orderNsu) {
    return new Response('Notificação sem order_nsu', { status: 400 });
  }

  const solicitacao = await buscarSolicitacaoPorReferencia(env, orderNsu);
  if (!solicitacao) {
    console.error('Notificação de pagamento sem solicitacao_moedas correspondente', orderNsu);
    return new Response('OK - solicitacao nao encontrada', { status: 200 });
  }

  if (solicitacao.status === 'pago') {
    return new Response('OK - ja processado', { status: 200 });
  }

  // Camada de segurança: nunca confiar só no corpo do webhook. Confirma
  // direto na API se o pagamento foi realmente aprovado.
  let confirmacao;
  try {
    const resp = await fetch('https://api.checkout.infinitepay.io/payment_check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.INFINITEPAY_TOKEN ? { Authorization: `Bearer ${env.INFINITEPAY_TOKEN.trim()}` } : {}),
      },
      body: JSON.stringify({
        handle: env.INFINITEPAY_HANDLE.trim().replace(/^\$/, ''),
        order_nsu: orderNsu,
        transaction_nsu: transactionNsu,
        slug: invoiceSlug,
      }),
    });
    if (!resp.ok) throw new Error(`payment_check retornou ${resp.status}`);
    confirmacao = await resp.json();
  } catch (e) {
    console.error('Falha ao confirmar pagamento direto na InfinitePay', e);
    return new Response('Falha ao confirmar pagamento', { status: 500 });
  }

  if (!confirmacao.success || !confirmacao.paid) {
    console.warn('payment_check não confirmou pagamento aprovado', orderNsu, confirmacao);
    return new Response('OK - pagamento nao confirmado', { status: 200 });
  }

  const valorEsperadoCentavos = Math.round(Number(solicitacao.valor_reais) * 100);
  const valorPagoCentavos = confirmacao.paid_amount ?? confirmacao.amount;
  if (typeof valorPagoCentavos !== 'number' || valorPagoCentavos < valorEsperadoCentavos) {
    console.error(
      'Valor pago menor que o esperado — não creditando',
      orderNsu,
      'esperado:', valorEsperadoCentavos,
      'pago:', valorPagoCentavos
    );
    return new Response('OK - valor nao confere', { status: 200 });
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
