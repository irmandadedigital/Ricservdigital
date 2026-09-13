// functions/api/chave-publica-cartao.js
//
// Devolve ao front-end a chave pública do PagBank usada para criptografar
// o cartão no navegador (SDK PagSeguro.encryptCard). Essa chave NÃO é
// secreta — ela só serve para criptografar, nunca para descriptografar —
// então é seguro expô-la para qualquer visitante logado.

export async function onRequestGet({ env }) {
  const PAGBANK_TOKEN = env.PAGBANK_TOKEN;
  const PAGBANK_ENV = env.PAGBANK_ENV || 'sandbox';
  const PAGBANK_BASE_URL =
    PAGBANK_ENV === 'production'
      ? 'https://api.pagseguro.com'
      : 'https://sandbox.api.pagseguro.com';

  try {
    const resp = await fetch(`${PAGBANK_BASE_URL}/public-keys/card`, {
      headers: {
        Authorization: `Bearer ${PAGBANK_TOKEN}`,
        Accept: 'application/json',
      },
    });
    const data = await resp.json();

    if (!resp.ok) {
      console.error('Falha ao obter chave pública do PagBank', data);
      return new Response(JSON.stringify({ erro: 'Não foi possível obter a chave de segurança' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ publicKey: data.public_key }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Erro ao chamar PagBank', e);
    return new Response(JSON.stringify({ erro: 'Falha ao comunicar com o PagBank' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
