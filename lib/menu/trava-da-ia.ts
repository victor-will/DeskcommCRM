import type { SupabaseClient } from "@supabase/supabase-js";

import { silencioVigente } from "@/lib/inbox/comando-da-conversa";

/**
 * A TRAVA DE CONVIVÊNCIA IA × menu (R1–R4) — as duas perguntas que a ação
 * `menu_responder` (Task 5) faz ANTES de responder. `true` = o menu cala.
 *
 * ─── As duas funções ────────────────────────────────────────────────────────
 *
 * - `bloqueioHumano`: o silêncio do humano e as réguas do contato já calam o
 *   menu — `bot_silenced_until` vigente, `force_human`, `ai_opt_out`,
 *   `is_blocked`, `is_personal` e conversa atribuída a pessoa
 *   (`assignee_kind = 'user'`). O silêncio tem precedência sobre o estado da
 *   máquina (Review Focus 4): a sessão pode estar em `aguardando_servico` à
 *   vontade, silêncio vigente é silêncio.
 *
 * - `iaResponderiaASessao`: o espelho em Supabase client do portão do dreno
 *   (`haQuemAtendaASessao`, `lib/ai/agents/quem-atende-a-sessao.ts:99`, pg) —
 *   o contexto de ação de automação não tem pool pg (medido) — mais o
 *   predicado de credencial do `lib/ai/gateway-binding.ts` (`is_active = true
 *   AND validated_at IS NOT NULL`). As três condições do contrato (brief da
 *   Task 4), na numeração dele:
 *     1. agente da org não arquivado, não pausado, com a versão POINTEIRA
 *        publicada nesta sessão (`ai_agent_versions.status = 'published'` e
 *        `channel_session_id = sessão`) → senão `false`;
 *     2. credencial da org ativa E validada → senão `false`;
 *     3. `conversations.bot_silenced_until` vigente → `true` (o silêncio cala
 *        a IA **e** o menu — é o que dá uso aos parâmetros `conversationId`/
 *        `agora`). A implementação testa o silêncio PRIMEIRO, como saída
 *        antecipada: ele decide sozinho, sem depender de existir agente.
 *   O portão pg também pergunta por `ai_routers`; o contrato desta função é a
 *   lista acima — escopo sem roteadores, declarado.
 *
 * ─── Falha FECHADA nos dois lados (decisão travada do controller) ───────────
 *
 * Erro de leitura = `true` em `bloqueioHumano` E em `iaResponderiaASessao`:
 * na dúvida o menu fica calado. "Menu assume por não saber" é o lado perigoso
 * do R1 — uma leitura quebrada é indistinguível de "tem IA aqui" e de "humano
 * mandou calar", e nos DOIS casos quem fala é quem já falava. Isto só vale para
 * estas travas: a máquina da Task 3 é pura e não lê nada.
 *
 * O client é o admin (service role): o filtro por organização é
 * PROGRAMÁTICO e obrigatório em toda query — anti-pattern 10 (CLAUDE.md).
 * Nunca logar telefone/segredo aqui: a função só devolve booleano.
 */

/**
 * `true` = o menu cala (silêncio / força humana / opt-out / bloqueio /
 * pessoal / conversa de gente).
 *
 * O `contact` JÁ vem lido da Task 5 — aqui só é consultado, nunca buscado. A
 * leitura da conversa é a única ida ao banco, e ela acontece só depois das
 * flags do contato (parâmetro puro, custo zero): contato já bloqueando nem
 * consulta. Conversa sem linha ainda (id novo) não é erro — não há silêncio
 * nem atribuição para respeitar.
 */
export async function bloqueioHumano(
  admin: SupabaseClient,
  orgId: string,
  conversationId: string | null,
  contact: {
    force_human?: boolean;
    ai_opt_out?: boolean;
    is_blocked?: boolean;
    is_personal?: boolean;
  } | null,
  agora: Date,
): Promise<boolean> {
  if (
    contact !== null &&
    (contact.force_human === true ||
      contact.ai_opt_out === true ||
      contact.is_blocked === true ||
      contact.is_personal === true)
  ) {
    return true;
  }

  if (conversationId === null) return false;

  const { data, error } = await admin
    .from("conversations")
    .select("bot_silenced_until, assignee_kind")
    .eq("id", conversationId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error !== null) return true; // falha fechada
  if (data === null) return false; // conversa ainda sem linha: nada a calar

  const conversa = data as { bot_silenced_until?: string | null; assignee_kind?: string | null };
  if (silencioVigente(conversa.bot_silenced_until, agora).vigente) return true;
  if (conversa.assignee_kind === "user") return true;
  return false;
}

/**
 * `true` = a IA (ou o humano) responderia esta sessão → o menu sai de perto.
 *
 * O espelho do portão `haQuemAtendaASessao` em PostgREST: o join vira embed
 * `!inner` pela MESMA chave (`ai_agents.published_version_id →
 * ai_agent_versions.id`, hint da FK em todos os usos do repo), e o predicado
 * de versão/paquete é o do SQL original — publicado E nesta sessão, com o agente
 * vivo e não pausado (`ignorarPausados` do portão, aqui sempre ligado: agente
 * pausado não responde, e quem não responde deixa o menu falar).
 */
export async function iaResponderiaASessao(
  admin: SupabaseClient,
  orgId: string,
  channelSessionId: string,
  conversationId: string | null,
  agora: Date,
): Promise<boolean> {
  // Passo 3 do contrato: silêncio vigente → true (cala a IA e o menu).
  if (conversationId !== null) {
    const { data, error } = await admin
      .from("conversations")
      .select("bot_silenced_until")
      .eq("id", conversationId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error !== null) return true; // falha fechada
    const conversa = data as { bot_silenced_until?: string | null } | null;
    if (conversa !== null && silencioVigente(conversa.bot_silenced_until, agora).vigente) {
      return true;
    }
  }

  // Passo 1: agente publicado NESTA sessão (o embed !inner é o exists() do SQL).
  const agente = await admin
    .from("ai_agents")
    .select(
      "id, ai_agent_versions!ai_agents_published_version_id_fkey!inner(status, channel_session_id)",
    )
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .is("paused_at", null)
    .eq("ai_agent_versions.status", "published")
    .eq("ai_agent_versions.channel_session_id", channelSessionId)
    .limit(1)
    .maybeSingle();
  if (agente.error !== null) return true; // falha fechada
  if (agente.data === null) return false; // sem agente publicado na sessão: menu assume

  // Passo 2: credencial da org ativa E validada (predicado do gateway-binding).
  const credencial = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .not("validated_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (credencial.error !== null) return true; // falha fechada
  return credencial.data !== null;
}
