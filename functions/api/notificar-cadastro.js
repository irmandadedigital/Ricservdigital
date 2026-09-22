// functions/api/notificar-cadastro.js
//
// Recebe o Database Webhook do Supabase (disparado ao inserir uma linha em "profiles")
// e envia um e-mail de notificação via Resend.
//
// Variáveis de ambiente necessárias (Cloudflare Pages > Settings > Environment variables):
//   RESEND_API_KEY  -> sua chave de API do Resend
//   WEBHOOK_SECRET  -> uma string aleatória que você escolhe (ex: gere em https://generate-secret.vercel.app/32)
//                      precisa ser IGUAL ao header configurado no webhook do Supabase
//   FROM_EMAIL      -> ex: "notificacoes@ricserv.digital" (precisa ser de um domínio verificado no Resend)
//   NOTIFY_EMAIL    -> ex: "contato@ricserv.digital" (quem recebe o aviso)

export async function onRequestPost(context) {
  const { request, env } = context

  // Segurança: só aceita chamadas que tragam o segredo combinado com o Supabase
  const secretRecebido = request.headers.get('x-webhook-secret')
  if (!env.WEBHOOK_SECRET || secretRecebido !== env.WEBHOOK_SECRET) {
    return new Response('Não autorizado', { status: 401 })
  }

  let payload
  try {
    payload = await request.json()
  } catch {
    return new Response('Payload inválido', { status: 400 })
  }

  // Só processa inserções na tabela profiles; ignora o resto sem erro
  if (payload.type !== 'INSERT' || payload.table !== 'profiles') {
    return new Response('Ignorado', { status: 200 })
  }

  const perfil = payload.record || {}
  const tipo =
    perfil.role === 'profissional' ? 'Profissional' : perfil.role === 'cliente' ? 'Cliente' : perfil.role || 'Desconhecido'
  const nome = perfil.nome || '(sem nome informado)'
  const telefone = perfil.telefone || '(sem telefone)'
  const cidade = perfil.cidade || '(sem cidade)'

  const assunto = `Novo cadastro: ${tipo} — ${nome}`
  const corpoHtml = `
    <h2>Novo cadastro no RicServ</h2>
    <p><strong>Tipo:</strong> ${tipo}</p>
    <p><strong>Nome:</strong> ${nome}</p>
    <p><strong>Telefone:</strong> ${telefone}</p>
    <p><strong>Cidade:</strong> ${cidade}</p>
    <p><strong>ID do perfil:</strong> ${perfil.id || '-'}</p>
  `

  const resendResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: env.NOTIFY_EMAIL,
      subject: assunto,
      html: corpoHtml,
    }),
  })

  if (!resendResp.ok) {
    const erro = await resendResp.text()
    return new Response(`Falha ao enviar e-mail: ${erro}`, { status: 502 })
  }

  return new Response('OK', { status: 200 })
}
