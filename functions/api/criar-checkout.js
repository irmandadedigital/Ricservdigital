// functions/api/criar-checkout.js
//
// Cria um Checkout PagBank (página hospedada pelo próprio PagBank, com Pix,
// cartão e boleto juntos) e devolve a URL pra abrir numa nova aba.
//
// Por que isso é mais simples que a integração anterior:
// - O PagBank coleta os dados do cliente (nome, CPF quando necessário) na
//   própria página dele — não precisamos mais exigir CPF no cadastro do
//   RicServ nem lidar com criptografia de cartão no nosso front-end.
// - Uma única chamada cobre os três métodos de pagamento.
//
// O valor NUNCA vem do navegador — é sempre resolvido aqui a partir de
// PACOTES, pra ninguém conseguir forjar um valor menor.

const PACOTES = {
  bronze: { quantidade: 20, valorReais: 20.0 },
  prata: { quantidade: 40, valorReais: 35.0 },
  ouro: { quantidade: 80, valorReais: 70.0 },
};

const BANDEIRAS_ACEITAS = ['VISA', 'MASTERCARD', 'ELO', 'AMEX', 'HIPERCARD'];

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

export async function onRequestPost({ request, env }) {
  const PAGBANK_ENV = env.PAGBANK_ENV || 'sandbox';
  const PAGBANK_BASE_URL =
    PAGBANK_ENV === 'production'
      ? 'https://api.pagseguro.com'
      : 'https://sandbox.api.pagseguro.com';

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

  const referenciaId = `ricserv-${usuario.id}-${Date.now()}`;

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
  const cpfLimpo = (perfil.cpf || '').replace(/\D/g, '');

  const checkoutPayload = {
    reference_id: referenciaId,
    customer_modifiable: true, // deixa o PagBank coletar/confirmar CPF e dados do cliente
    items: [
      {
        reference_id: referenciaId,
        name: `${pacote.quantidade} moedas RicServ`,
        quantity: 1,
        unit_amount: valorCentavos,
      },
    ],
    customer: {
      name: perfil.nome_completo || perfil.nome || undefined,
      email: usuario.email,
      tax_id: cpfLimpo || undefined,
    },
    payment_methods: [
      { type: 'PIX' },
      { type: 'BOLETO' },
      { type: 'CREDIT_CARD', brands: BANDEIRAS_ACEITAS },
      { type: 'DEBIT_CARD', brands: BANDEIRAS_ACEITAS },
    ],
    payment_methods_configs: [
      {
        type: 'CREDIT_CARD',
        config_options: [{ option: 'INSTALLMENTS_LIMIT', value: '3' }],
      },
    ],
    redirect_url: `${env.SITE_URL}/comprar-moedas.html?checkout=retorno`,
    payment_notification_urls: [`${env.SITE_URL}/api/webhook-pagbank`],
  };

  if (!checkoutPayload.customer.name) delete checkoutPayload.customer.name;
  if (!checkoutPayload.customer.tax_id) delete checkoutPayload.customer.tax_id;

  let pagbankResp, pagbankData;
  try {
    pagbankResp = await fetch(`${PAGBANK_BASE_URL}/checkouts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PAGBANK_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(checkoutPayload),
    });
    pagbankData = await pagbankResp.json();
  } catch (e) {
    console.error('Erro ao chamar PagBank (checkout)', e);
    await atualizarSolicitacao(env, solicitacao.id, { status: 'cancelado' });
    return jsonResponse(502, { erro: 'Falha ao comunicar com o PagBank' });
  }

  if (!pagbankResp.ok) {
    console.error('PagBank recusou a criação do checkout', pagbankData);
    await atualizarSolicitacao(env, solicitacao.id, { status: 'cancelado' });
    return jsonResponse(502, {
      erro: 'PagBank recusou a criação do checkout',
      detalhes: pagbankData,
    });
  }

  const linkPagamento = (pagbankData.links || []).find((l) => l.rel === 'PAY');
  if (!linkPagamento) {
    console.error('PagBank não retornou link PAY', pagbankData);
    await atualizarSolicitacao(env, solicitacao.id, { status: 'cancelado' });
    return jsonResponse(502, { erro: 'PagBank não retornou o link de pagamento' });
  }

  await atualizarSolicitacao(env, solicitacao.id, {
    pagbank_checkout_id: pagbankData.id,
  });

  return jsonResponse(200, {
    solicitacaoId: solicitacao.id,
    checkoutUrl: linkPagamento.href,
  });
  }
