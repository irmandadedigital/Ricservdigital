// functions/api/simular-pagamento-sandbox.js
//
// Ferramenta de TESTE: chama o endpoint de simulação de pagamento do
// PagBank em ambiente sandbox. Isso permite testar o ciclo completo
// (QR Code -> webhook -> moedas creditadas) sem precisar pagar de verdade.
//
// Trava de segurança: só funciona se PAGBANK_ENV=sandbox. Em produção essa
// function sempre recusa.

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

async function buscarSolicitacao(env, id, profissionalId) {
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/solicitacoes_moedas?id=eq.${id}&profissional_id=eq.${profissionalId}&select=*`,
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

export async function onRequestPost({ request, env }) {
  const PAGBANK_ENV = env.PAGBANK_ENV || 'sandbox';

  if (PAGBANK_ENV !== 'sandbox') {
    return jsonResponse(403, { erro: 'Simulação só é permitida em ambiente sandbox' });
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

  const solicitacao = await buscarSolicitacao(env, body.solicitacaoId, usuario.id);
  if (!solicitacao || !solicitacao.pagbank_order_id) {
    return jsonResponse(404, { erro: 'Solicitação não encontrada ou sem pedido no PagBank' });
  }

  const valorCentavos = Math.round(Number(solicitacao.valor_reais) * 100);

  let pagbankResp, pagbankData;
  try {
    pagbankResp = await fetch(
      `https://sandbox.api.pagseguro.com/orders/${solicitacao.pagbank_order_id}/pay`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.PAGBANK_TOKEN}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          charges: [
            {
              amount: { value: valorCentavos, currency: 'BRL' },
              payment_method: {
                type: 'PIX',
                pix: { expiration_date: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
              },
            },
          ],
        }),
      }
    );
    const texto = await pagbankResp.text();
    pagbankData = texto ? JSON.parse(texto) : {};
  } catch (e) {
    console.error('Erro ao chamar simulação do PagBank', e);
    return jsonResponse(502, { erro: 'Falha ao comunicar com o PagBank' });
  }

  if (!pagbankResp.ok) {
    console.error('PagBank recusou a simulação', pagbankData);
    return jsonResponse(502, {
      erro: 'PagBank recusou a simulação',
      detalhes: pagbankData,
    });
  }

  return jsonResponse(200, {
    ok: true,
    mensagem: 'Pagamento simulado. Aguarde alguns segundos para o webhook confirmar e creditar as moedas.',
    resposta: pagbankData,
  });
      }
