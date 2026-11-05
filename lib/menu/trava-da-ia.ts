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
 *   AND validated_at IS NOT NULL`). As condições do contrato, na numeração do
 *   brief (Task 4) + o roteador que a spec §6.3 R1 ("IA sempre prioridade")
 *   exige e a lista do plan deixou de fora:
 *     1. agente da org não arquivado, não pausado, com a versão POINTEIRA
 *        publicada nesta sessão (`ai_agent_versions.status = 'published'` e
 *        `channel_session_id = sessão`) → senão, o OUTRO lado do `OR` do
 *        portão: roteador ativo na sessão cujo fallback OU algum membro
 *        esteja vivo e com versão publicada — SEM predicado de sessão sobre
 *        eles (mesmos predicados de `quem-atenda-a-sessao.ts:57-85`, com a
 *        pausa excluída como no passo 1). Nada dos dois → `false`;
 *     2. credencial da org ativa E validada → senão `false`;
 *     3. `conversations.bot_silenced_until` vigente → `true` (o silêncio cala
 *        a IA **e** o menu — é o que dá uso aos parâmetros `conversationId`/
 *        `agora`). A implementação testa o silêncio PRIMEIRO, como saída
 *        antecipada: ele decide sozinho, sem depender de existir agente.
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

  // Passo 1a: agente publicado NESTA sessão (o embed !inner é o exists() do SQL).
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

  // Passo 1b: o OUTRO lado do OR do portão — sem agente direto, o roteador
  // ativo da sessão pode estar respondendo (R1: IA sempre prioridade).
  if (agente.data === null) {
    const roteador = await espelhaORoteador(admin, orgId, channelSessionId);
    if (roteador.erro) return true; // falha fechada
    if (!roteador.ativo) return false; // nem agente nem roteador: menu assume
  }

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

/**
 * O `OR` do portão que sobra quando não há agente direto
 * (`quem-atende-a-sessao.ts:55-86`): roteador ATIVO nesta sessão (o índice
 * `uniq_ai_routers_active_session` garante um só) com fallback OU algum
 * membro VIVO e com versão publicada.
 *
 * Mesmos predicados do SQL de origem: org do agente, não arquivado, não
 * pausado (a variante `ignorarPausados` — a mesma escolha do passo 1: quem
 * está pausado não responde) e versão `published` SEM `channel_session_id`
 * sobre fallback/membros — eles respondem de qualquer número, e é por isto
 * que o agente DIRETO não os acha e este ramo existe.
 *
 * `erro` separa "não tem" de "não pude ler": o chamador fecha para `true` em
 * qualquer erro (falha fechada), e um "não tem" limpo vira o `false` do portão.
 * Filtro de organização em TODA query (anti-pattern 10).
 */
async function espelhaORoteador(
  admin: SupabaseClient,
  orgId: string,
  channelSessionId: string,
): Promise<{ erro: boolean; ativo: boolean }> {
  const { data: roteadores, error: erroRoteador } = await admin
    .from("ai_routers")
    .select("id, fallback_agent_id")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .eq("channel_session_id", channelSessionId);
  if (erroRoteador !== null) return { erro: true, ativo: false };
  const linhas = roteadores ?? [];
  if (linhas.length === 0) return { erro: false, ativo: false };

  const { data: membros, error: erroMembros } = await admin
    .from("ai_router_members")
    .select("agent_id")
    .eq("organization_id", orgId)
    .in(
      "router_id",
      linhas.map((r) => r.id),
    );
  if (erroMembros !== null) return { erro: true, ativo: false };

  const candidatos = [
    ...linhas.map((r) => r.fallback_agent_id),
    ...(membros ?? []).map((m) => m.agent_id),
  ].filter((id): id is string => typeof id === "string");
  if (candidatos.length === 0) return { erro: false, ativo: false };

  const { data: vivo, error: erroAgentes } = await admin
    .from("ai_agents")
    .select("id, ai_agent_versions!ai_agents_published_version_id_fkey!inner(status)")
    .in("id", [...new Set(candidatos)])
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .is("paused_at", null)
    .eq("ai_agent_versions.status", "published")
    .limit(1)
    .maybeSingle();
  if (erroAgentes !== null) return { erro: true, ativo: false };
  return { erro: false, ativo: vivo !== null };
}
