// functions/api/criar-pedido-pix.js
//
// Cria um pedido de pagamento no PagBank (Pix OU Boleto) para um pacote de
// moedas. Chamado pelo front-end (comprar-moedas.html) com o token de sessão
// do Supabase do profissional logado. NUNCA recebe o valor em reais do
// cliente — o valor é sempre resolvido aqui, no servidor, a partir de
// PACOTES abaixo, para que ninguém consiga forjar um valor menor.
//
// Cartão de crédito NÃO é criado aqui: por segurança, o PagBank exige que o
// número do cartão seja criptografado no navegador do cliente (SDK PagBank.js)
// antes de qualquer dado chegar a um servidor.

const PACOTES = {
  bronze: { quantidade: 20, valorReais: 20.0 },
  prata: { quantidade: 40, valorReais: 35.0 },
  ouro: { quantidade: 80, valorReais: 70.0 },
};

const FORMAS_PAGAMENTO_ACEITAS = ['PIX', 'BOLETO', 'CREDIT_CARD'];

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
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`,
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

async function criarSolicitacao(env, { profissionalId, quantidade, valorReais, referenciaId, formaPagamento }) {
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
      metodo_pagamento: formaPagamento,
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

// Chama a função SQL credit_moedas(profissional_id, quantidade) — a mesma
// usada pelo webhook. Cartão precisa disso aqui também porque a confirmação
// é síncrona (não passa pelo webhook antes do usuário ver o resultado).
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
  if (!resp.ok) throw new Error(`Falha ao creditar moedas: ${await resp.text()}`);
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
  const accessToken = authHeader.slice('Bearer '.length);

  const usuario = await getUsuarioAutenticado(env, accessToken);
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

  const formaPagamento = FORMAS_PAGAMENTO_ACEITAS.includes(body.formaPagamento)
    ? body.formaPagamento
    : 'PIX';

  const perfil = await buscarPerfil(env, usuario.id);
  if (!perfil || perfil.role !== 'profissional') {
    return jsonResponse(403, { erro: 'Apenas profissionais podem comprar moedas' });
  }

  // O PagBank passou a exigir CPF do comprador (customer.tax_id) para
  // qualquer forma de pagamento, incluindo PIX — não só Boleto/Cartão.
  const cpf = (perfil.cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11) {
    return jsonResponse(400, { erro: 'Cadastre um CPF válido no seu perfil para comprar moedas' });
  }

  // Cartão: o front-end já criptografou os dados no navegador (SDK PagSeguro.encryptCard)
  // e manda só o resultado — número, CVV etc. NUNCA chegam ao nosso servidor em texto puro.
  if (formaPagamento === 'CREDIT_CARD' && !body.encryptedCard) {
    return jsonResponse(400, { erro: 'Dados do cartão ausentes' });
  }
  const parcelas = formaPagamento === 'CREDIT_CARD' ? Math.min(Math.max(parseInt(body.parcelas, 10) || 1, 1), 3) : null;

  const referenciaId = `ricserv-${usuario.id}-${Date.now()}`;

  let solicitacao;
  try {
    solicitacao = await criarSolicitacao(env, {
      profissionalId: usuario.id,
      quantidade: pacote.quantidade,
      valorReais: pacote.valorReais,
      referenciaId,
      formaPagamento,
    });
  } catch (e) {
    console.error('Erro ao criar solicitacao', e);
    return jsonResponse(500, { erro: 'Não foi possível registrar a solicitação' });
  }

  const valorCentavos = Math.round(pacote.valorReais * 100);

  // Pix expira em 30 min; boleto damos 3 dias corridos de prazo; cartão não
  // tem "expiração" (confirma na hora), o valor aqui só documenta o pedido.
  const expiracao =
    formaPagamento === 'PIX'
      ? new Date(Date.now() + 30 * 60 * 1000)
      : formaPagamento === 'BOLETO'
      ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 5 * 60 * 1000);

  let paymentMethod;
  if (formaPagamento === 'PIX') {
    paymentMethod = { type: 'PIX', pix: { expiration_date: expiracao.toISOString() } };
  } else if (formaPagamento === 'BOLETO') {
    paymentMethod = {
      type: 'BOLETO',
      boleto: {
        due_date: expiracao.toISOString().slice(0, 10),
        instruction_lines: {
          line_1: 'Pagamento processado para RicServ',
          line_2: `Pacote de ${pacote.quantidade} moedas`,
        },
        holder: {
          name: perfil.nome_completo || perfil.nome || usuario.email,
          tax_id: cpf,
          email: usuario.email,
          address: {
            street: perfil.endereco_rua || 'Não informado',
            number: perfil.endereco_numero || 'SN',
            locality: perfil.cidade || 'Não informado',
            city: perfil.cidade || 'Não informado',
            region_code: perfil.estado || 'SP',
            country: 'BRA',
            postal_code: (perfil.cep || '00000000').replace(/\D/g, ''),
          },
        },
      },
    };
  } else {
    // CREDIT_CARD
    paymentMethod = {
      type: 'CREDIT_CARD',
      installments: parcelas,
      capture: true,
      card: {
        encrypted: body.encryptedCard,
        store: false,
      },
      holder: {
        name: perfil.nome_completo || perfil.nome || usuario.email,
        tax_id: cpf,
      },
    };
  }

  const pedidoPayload = {
    reference_id: referenciaId,
    customer: {
      name: perfil.nome_completo || perfil.nome || usuario.email,
      email: usuario.email,
      tax_id: cpf || undefined,
    },
    items: [
      {
        reference_id: referenciaId,
        name: `${pacote.quantidade} moedas RicServ`,
        quantity: 1,
        unit_amount: valorCentavos,
      },
    ],
    charges: [
      {
        reference_id: referenciaId,
        description: `Compra de ${pacote.quantidade} moedas - RicServ`,
        amount: { value: valorCentavos, currency: 'BRL' },
        payment_method: paymentMethod,
      },
    ],
    notification_urls: [`${env.SITE_URL}/api/webhook-pagbank`],
  };

  if (!pedidoPayload.customer.tax_id) delete pedidoPayload.customer.tax_id;

  let pagbankResp, pagbankData;
  try {
    pagbankResp = await fetch(`${PAGBANK_BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PAGBANK_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pedidoPayload),
    });
    pagbankData = await pagbankResp.json();
  } catch (e) {
    console.error('Erro ao chamar PagBank', e);
    await atualizarSolicitacao(env, solicitacao.id, { status: 'cancelado' });
    return jsonResponse(502, { erro: 'Falha ao comunicar com o PagBank' });
  }

  if (!pagbankResp.ok) {
    console.error('PagBank recusou o pedido', pagbankData);
    await atualizarSolicitacao(env, solicitacao.id, { status: 'cancelado' });
    return jsonResponse(502, { erro: 'PagBank recusou a criação do pedido' });
  }

  const charge = pagbankData.charges && pagbankData.charges[0];
  if (!charge) {
    await atualizarSolicitacao(env, solicitacao.id, { status: 'cancelado' });
    return jsonResponse(502, { erro: 'PagBank não retornou uma cobrança válida' });
  }

  // Cartão confirma NA HORA (síncrono) — não fica "aguardando" como Pix/Boleto.
  if (formaPagamento === 'CREDIT_CARD') {
    if (charge.status === 'PAID') {
      try {
        await creditarMoedas(env, usuario.id, pacote.quantidade);
        await atualizarSolicitacao(env, solicitacao.id, {
          status: 'pago',
          pagbank_order_id: pagbankData.id,
          pagbank_charge_id: charge.id,
          pago_em: new Date().toISOString(),
        });
      } catch (e) {
        console.error('Pagamento aprovado mas falhou ao creditar moedas', e);
        return jsonResponse(500, { erro: 'Pagamento aprovado, mas houve falha ao creditar moedas. Contate o suporte.' });
      }
      return jsonResponse(200, { solicitacaoId: solicitacao.id, statusCartao: 'PAID' });
    }

    await atualizarSolicitacao(env, solicitacao.id, {
      status: charge.status === 'IN_ANALYSIS' ? 'pendente' : 'cancelado',
      pagbank_order_id: pagbankData.id,
      pagbank_charge_id: charge.id,
    });

    if (charge.status === 'IN_ANALYSIS') {
      return jsonResponse(200, { solicitacaoId: solicitacao.id, statusCartao: 'IN_ANALYSIS' });
    }

    const motivo = charge.payment_response && charge.payment_response.message;
    return jsonResponse(402, { erro: motivo || 'Pagamento com cartão recusado' });
  }

  // PIX e BOLETO: fluxo assíncrono normal, aguardando confirmação via webhook.
  if (charge.status !== 'WAITING') {
    await atualizarSolicitacao(env, solicitacao.id, { status: 'cancelado' });
    return jsonResponse(502, { erro: 'Pedido não ficou aguardando pagamento (recusado pela análise de risco)' });
  }

  if (formaPagamento === 'PIX') {
    const linkImagem = (charge.links || []).find((l) => l.rel === 'QRCODE.PNG');

    await atualizarSolicitacao(env, solicitacao.id, {
      pagbank_order_id: pagbankData.id,
      pagbank_charge_id: charge.id,
      qr_code_text: charge.qr_code.text,
      qr_code_image_url: linkImagem ? linkImagem.href : null,
      expiracao: expiracao.toISOString(),
    });

    return jsonResponse(200, {
      solicitacaoId: solicitacao.id,
      qrCodeTexto: charge.qr_code.text,
      qrCodeImagemUrl: linkImagem ? linkImagem.href : null,
      expiracao: expiracao.toISOString(),
    });
  }

  // BOLETO: o link do PDF vem dentro de payment_method.boleto ou em links
  const boletoUrl =
    (charge.payment_method &&
      charge.payment_method.boleto &&
      charge.payment_method.boleto.formatted_barcode &&
      charge.links &&
      (charge.links.find((l) => l.rel === 'BOLETO_PDF') || {}).href) ||
    (charge.links && (charge.links.find((l) => l.media === 'application/pdf') || {}).href);

  await atualizarSolicitacao(env, solicitacao.id, {
    pagbank_order_id: pagbankData.id,
    pagbank_charge_id: charge.id,
    boleto_url: boletoUrl || null,
    expiracao: expiracao.toISOString(),
  });

  return jsonResponse(200, {
    solicitacaoId: solicitacao.id,
    boletoUrl,
    expiracao: expiracao.toISOString(),
  });
}
