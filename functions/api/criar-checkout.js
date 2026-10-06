// functions/api/criar-checkout.js
//
// Cria um link de Checkout da InfinitePay (página hospedada por eles, com
// Pix e cartão juntos) e devolve a URL pra abrir numa nova aba.
//
// O valor NUNCA vem do navegador — é sempre resolvido aqui a partir de
// PACOTES, pra ninguém conseguir forjar um valor menor.

const PACOTES = {
  teste: { quantidade: 10, valorReais: 10.0 },
  inicial: { quantidade: 10, valorReais: 9.9 },
  bronze: { quantidade: 20, valorReais: 20.0 },
  prata: { quantidade: 40, valorReais: 35.0 },
  ouro: { quantidade: 80, valorReais: 70.0 },
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function getUsuarioAutenticado(env, accessToken) {
  const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function buscarPerfil(env, userId) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const rows = await resp.json();
  return rows[0] || null;
}

async function criarSolicitacao(env, { profissionalId, quantidade, valorReais, referenciaId }) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/solicitacoes_moedas`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      profissional_id: profissionalId,
      quantidade,
      valor_reais: valorReais,
      status: 'pendente',
      referencia_id: referenciaId,
      metodo_pagamento: 'CHECKOUT',
    }),
  });
  const rows = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(rows));
  return rows[0];
}

async function atualizarSolicitacao(env, id, campos) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/solicitacoes_moedas?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(campos),
  });
}

export async function onRequestPost(context) {
  try {
    return await handleCriarCheckout(context);
  } catch (e) {
    console.error('Erro inesperado em criar-checkout', e && e.stack ? e.stack : e);
    return jsonResponse(500, {
      erro: 'Erro interno ao criar o checkout',
      detalhes: e && e.message ? e.message : String(e),
    });
  }
}

async function handleCriarCheckout({ request, env }) {
  const obrigatorias = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'INFINITEPAY_HANDLE',
    'SITE_URL',
  ];
  const faltando = obrigatorias.filter((nome) => !env[nome]);
  if (faltando.length) {
    console.error('Variáveis de ambiente faltando:', faltando.join(', '));
    return jsonResponse(500, {
      erro: 'Configuração incompleta no servidor',
      detalhes: `Variáveis de ambiente faltando: ${faltando.join(', ')}`,
    });
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse(401, { erro: 'Não autenticado' });
  }
  const usuario = await getUsuarioAutenticado(env, authHeader.slice('Bearer '.length));
  if (!usuario || !usuario.id) {
    return jsonResponse(401, { erro: 'Sessão inválida' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { erro: 'JSON inválido' });
  }

  const pacote = PACOTES[body.pacoteId];
  if (!pacote) {
    return jsonResponse(400, { erro: 'Pacote inválido' });
  }

  const perfil = await buscarPerfil(env, usuario.id);
  if (!perfil || perfil.role !== 'profissional') {
    return jsonResponse(403, { erro: 'Apenas profissionais podem comprar moedas' });
  }

  // Usamos um UUID como order_nsu: é o identificador que a InfinitePay nos
  // devolve de volta no webhook e no payment_check, e é o mesmo valor que
  // gravamos em referencia_id pra depois casar com a solicitação certa.
  const referenciaId = crypto.randomUUID();

  let solicitacao;
  try {
    solicitacao = await criarSolicitacao(env, {
      profissionalId: usuario.id,
      quantidade: pacote.quantidade,
      valorReais: pacote.valorReais,
      referenciaId,
    });
  } catch (e) {
    console.error('Erro ao criar solicitacao', e);
    return jsonResponse(500, { erro: 'Não foi possível registrar a solicitação' });
  }

  const valorCentavos = Math.round(pacote.valorReais * 100);

  const checkoutPayload = {
    handle: env.INFINITEPAY_HANDLE.trim().replace(/^\$/, ''),
    order_nsu: referenciaId,
    items: [
      {
        quantity: 1,
        price: valorCentavos,
        description: `${pacote.quantidade} moedas RicServ`,
      },
    ],
    redirect_url: `${env.SITE_URL}/comprar-moedas.html?checkout=retorno`,
    webhook_url: `${env.SITE_URL}/api/webhook-infinitepay`,
    customer: {
      name: perfil.nome_completo || perfil.nome || undefined,
      email: usuario.email || undefined,
    },
  };
  if (!checkoutPayload.customer.name) delete checkoutPayload.customer.name;
  if (!checkoutPayload.customer.email) delete checkoutPayload.customer.email;
  if (!Object.keys(checkoutPayload.customer).length) delete checkoutPayload.customer;

  let infiniteResp, infiniteData;
  try {
    infiniteResp = await fetch('https://api.checkout.infinitepay.io/links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.INFINITEPAY_TOKEN ? { Authorization: `Bearer ${env.INFINITEPAY_TOKEN.trim()}` } : {}),
      },
      body: JSON.stringify(checkoutPayload),
    });
    infiniteData = await infiniteResp.json();
  } catch (e) {
    console.error('Erro ao chamar InfinitePay (checkout)', e);
    await atualizarSolicitacao(env, solicitacao.id, { status: 'cancelado' });
    return jsonResponse(502, { erro: 'Falha ao comunicar com a InfinitePay' });
  }

  if (!infiniteResp.ok || !infiniteData.url) {
    console.error('InfinitePay recusou a criação do checkout', infiniteData);
    await atualizarSolicitacao(env, solicitacao.id, { status: 'cancelado' });
    return jsonResponse(502, {
      erro: 'InfinitePay recusou a criação do checkout',
      detalhes: infiniteData,
    });
  }

  return jsonResponse(200, {
    solicitacaoId: solicitacao.id,
    checkoutUrl: infiniteData.url,
  });
}
