// functions/api/liberar-contato.js
//
// Libera o contato de UM pedido pro profissional, descontando moedas do
// saldo dele (profiles.saldo_moedas). Não abre checkout nenhum — é na hora,
// só funciona se o profissional já tiver moedas suficientes.
//
// Quem garante que não dá pra gastar moeda que não tem é a função SQL
// gastar_moedas_liberar_contato (SECURITY DEFINER, trava a linha do
// profissional antes de descontar).

const CUSTO_MOEDAS_POR_CONTATO = 10;

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

async function buscarPedido(env, requestId) {
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/service_requests?id=eq.${encodeURIComponent(requestId)}&select=id`,
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

export async function onRequestPost(context) {
  try {
    return await handleLiberarContato(context);
  } catch (e) {
    console.error('Erro inesperado em liberar-contato', e && e.stack ? e.stack : e);
    return jsonResponse(500, {
      erro: 'Erro interno ao liberar o contato',
      detalhes: e && e.message ? e.message : String(e),
    });
  }
}

async function handleLiberarContato({ request, env }) {
  const obrigatorias = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
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

  const requestId = body.requestId;
  if (!requestId) {
    return jsonResponse(400, { erro: 'Pedido inválido' });
  }

  const perfil = await buscarPerfil(env, usuario.id);
  if (!perfil || perfil.role !== 'profissional') {
    return jsonResponse(403, { erro: 'Apenas profissionais podem liberar contatos' });
  }

  const pedido = await buscarPedido(env, requestId);
  if (!pedido) {
    return jsonResponse(404, { erro: 'Pedido não encontrado' });
  }

  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/gastar_moedas_liberar_contato`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_profissional_id: usuario.id,
      p_request_id: requestId,
      p_custo: CUSTO_MOEDAS_POR_CONTATO,
    }),
  });

  if (!resp.ok) {
    const textoErro = await resp.text();
    if (textoErro.includes('SALDO_INSUFICIENTE')) {
      return jsonResponse(402, {
        erro: 'Saldo de moedas insuficiente',
        saldoAtual: perfil.saldo_moedas ?? 0,
        custoMoedas: CUSTO_MOEDAS_POR_CONTATO,
      });
    }
    console.error('Erro ao chamar gastar_moedas_liberar_contato', textoErro);
    return jsonResponse(500, { erro: 'Não foi possível liberar o contato' });
  }

  return jsonResponse(200, { liberado: true });
}
