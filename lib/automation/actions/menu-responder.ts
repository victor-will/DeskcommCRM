import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { diaLocalISO, partesNoFuso } from "@/lib/agenda/fuso";
import { horariosLivresDaOrg } from "@/lib/agenda/consulta";
import { registerAction } from "@/lib/automation/actions";
import { mensagemDeErro } from "@/lib/automation/actions/erro-legivel";
import { reportarEnvio, type MensagemEnviada } from "@/lib/automation/desfecho-do-envio";
import { espacarEnvio } from "@/lib/automation/throttle";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { serviceForAutomation } from "@/lib/atendimento/origem-automacao";
import {
  formatarDia,
  proximoPasso,
  type Estado,
  type ItemDoMenu,
  type ServicoDoMenu,
} from "@/lib/menu/maquina";
import { bloqueioHumano, iaResponderiaASessao } from "@/lib/menu/trava-da-ia";

/**
 * `menu_responder` — a ação que faz o menu de texto falar (spec §6.1 + P5;
 * fluxo travado 1–9 da Task 5).
 *
 * ─── O que ela faz, na ordem TRAVADA ────────────────────────────────────────
 *
 * 0. corpo vazio (só mídia), sem contato ou sem sessão → `skipped` sem tocar
 *    em banco nenhum (ruling: `body_preview` vazio é mídia, não menu);
 * 1. `organizations.settings.menu.enabled !== true` → `skipped`;
 * 2. `bloqueioHumano` (silêncio do humano, atribuição a pessoa, flags do
 *    contato) → `skipped` — a LEITURA do contato é daqui e distinguir ERRO de
 *    "sem linha" é ruling: erro → `skipped` (nunca `null` pós-erro), linha
 *    ausente → `null` (sem sinal);
 * 3. `iaResponderiaASessao` (agente/roteador + credencial + silêncio) →
 *    `skipped` — R1/R2: IA comanda, e as travas da Task 4 rodam AQUI dentro
 *    por defesa em profundidade (decisão travada);
 * 4. carrega `menu_sessoes` (erro → `skipped`: sem estado confiável a máquina
 *    não decide) e `menu_itens` ativos (erro → `skipped`: a tabela do módulo
 *    sumir significa módulo fora);
 * 5. monta o contexto — serviços de `calendar_event_types`, e a DISPONIBILIDADE
 *    sempre pela `horariosLivresDaOrg` (B8: nunca reescrever a régua);
 * 6. `proximoPasso` → `resposta: null` → `skipped`;
 * 7. envio pelo MESMO caminho de `send-whatsapp.ts` (serviceForAutomation →
 *    espacarEnvio → `sendMessageHandler` com `actor {type:"webhook_source"}` e
 *    `requestId "rule:<id>"` → `reportarEnvio`) — sem reimplementar janela,
 *    pacing ou cap;
 * 8. **estado só avança em `success`** (Review Focus 3): qualquer recusa —
 *    exceção do handler (`janela_fechada`), mensagem `failed` ou `queued` —
 *    devolve o desfecho SEM gravar, e a máquina continua onde estava;
 * 9. sem `audit()`: o motor já registra `automation_rule_runs`.
 *
 * ─── A disponibilidade e a "uma chamada" do brief ───────────────────────────
 *
 * A função é POR TIPO DE SERVIÇO (`eventTypeId` obrigatório — medido em
 * `lib/agenda/consulta.ts`). Onde o serviço está determinado, é EXATAMENTE
 * uma chamada: escolha da tecla em `aguardando_servico` (pré-leitura do número
 * — quem VALIDA e transiciona continua sendo a máquina), serviço já gravado em
 * `dados` nos passos `aguardando_dia`/`aguardando_horario`. A única exceção é
 * a consulta fixa "horários de hoje" no `menu`, onde não há serviço na mão: aí
 * é a união dos ativos, uma chamada POR serviço — a régua continua sendo a da
 * própria função (B8), só que agregada. Consulta recusada/falha vira lista
 * vazia, e a máquina responde com os textos de vazio dela (G1 preservado).
 *
 * `linkAgenda` fica `undefined` na Peça A: a página pública `/a/<slug>` é da
 * Peça B — mandar cliente para link que não existe é bug; quando a B nascer,
 * o valor vem de `settings.agenda_online` + `organizations.slug`.
 */

const TIPO = "menu_responder";
const JANELA_DIAS = 14;

function pulo(reason: string): ActionResultDetail {
  return { type: TIPO, status: "skipped", detail: { reason } };
}

/** Número da tecla digitada, ou `null` (não-numérico). */
function comoNumero(texto: string): number | null {
  return /^\d+$/.test(texto) ? Number(texto) : null;
}

/**
 * Para QUAL serviço a disponibilidade é perguntada — a pré-leitura que torna
 * "uma chamada" possível num fluxo de passo único. Não decide nada: só escolhe
 * a régua a consultar; quem valida e transiciona é `proximoPasso`.
 */
function alvosDaDisponibilidade(
  servicos: readonly ServicoDoMenu[],
  estado: Estado,
  dados: Record<string, unknown>,
  corpo: string,
): string[] {
  const n = comoNumero(corpo);
  if (estado === "aguardando_horario" || estado === "aguardando_dia") {
    const escolhido =
      typeof dados.servico_event_type_id === "string" ? dados.servico_event_type_id : null;
    return escolhido === null ? [] : [escolhido];
  }
  if (estado === "aguardando_servico") {
    if (n === null || n < 1 || n > servicos.length) return []; // tecla que a máquina vai recusar: nada a consultar
    return [servicos[n - 1]!.event_type_id];
  }
  if (estado === "menu" && n === 1) {
    // "Horários de hoje" sem serviço escolhido: união dos ativos.
    return servicos.map((s) => s.event_type_id);
  }
  return [];
}

interface Disponibilidade {
  diasComVaga: Array<{ data: string; rotulo: string }>;
  horariosDoDia: string[];
}

/**
 * Dias com vaga (agrupados por dia LOCAL DA REGRA — `diaLocalISO` com o
 * `fusoDaRegra` que a própria consulta devolve) e os horários do dia que o
 * passo atual vai mostrar: o escolhido pela tecla em `aguardando_dia`, o de
 * `dados.dia` em `aguardando_horario`, e senão os de HOJE (a consulta fixa 1).
 */
async function montarDisponibilidade(
  admin: ActionCtx["admin"],
  orgId: string,
  servicos: readonly ServicoDoMenu[],
  estado: Estado,
  dados: Record<string, unknown>,
  corpo: string,
  agora: Date,
): Promise<Disponibilidade> {
  const alvos = alvosDaDisponibilidade(servicos, estado, dados, corpo);
  if (alvos.length === 0) return { diasComVaga: [], horariosDoDia: [] };

  const de = agora;
  const ate = new Date(agora.getTime() + JANELA_DIAS * 24 * 60 * 60 * 1000);
  const porDia = new Map<string, Set<string>>();
  let fuso: string | null = null;

  for (const eventTypeId of alvos) {
    const r = await horariosLivresDaOrg(admin, orgId, { eventTypeId, de, ate, agora });
    if (!r.ok) continue; // recusa/falha da consulta → sem slots deste alvo; a máquina tem texto de vazio
    fuso ??= r.fusoDaRegra;
    for (const slot of r.slots) {
      const data = diaLocalISO(slot.inicio, r.fusoDaRegra);
      const horas = porDia.get(data) ?? new Set<string>();
      const p = partesNoFuso(slot.inicio, r.fusoDaRegra);
      horas.add(`${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`);
      porDia.set(data, horas);
    }
  }

  const dias = [...porDia.keys()].sort();
  const n = comoNumero(corpo);
  let horarios: string[] = [];
  if (estado === "aguardando_dia" && n !== null && n >= 1 && n <= dias.length) {
    horarios = [...(porDia.get(dias[n - 1]!) ?? [])].sort();
  } else if (estado === "aguardando_horario" && typeof dados.dia === "string") {
    horarios = [...(porDia.get(dados.dia) ?? [])].sort();
  } else if (fuso !== null) {
    horarios = [...(porDia.get(diaLocalISO(agora, fuso)) ?? [])].sort();
  }

  return {
    diasComVaga: dias.map((data) => ({ data, rotulo: formatarDia(data) })),
    horariosDoDia: horarios,
  };
}

async function execute(
  ctx: ActionCtx,
  _config: Record<string, unknown>,
): Promise<ActionResultDetail> {
  // ── 0. Sem corpo, sem contato ou sem sessão: nada a fazer ──────────────────
  const p = (ctx.event?.payload ?? {}) as Record<string, unknown>;
  const corpo = typeof p.body_preview === "string" ? p.body_preview.trim() : "";
  if (corpo === "") return pulo("corpo_vazio");
  const contactId = typeof p.contact_id === "string" ? p.contact_id : null;
  if (contactId === null) return pulo("sem_contato");
  const sessionId = typeof p.channel_session_id === "string" ? p.channel_session_id : null;
  if (sessionId === null) return pulo("sem_sessao");
  const conversationId = typeof p.conversation_id === "string" ? p.conversation_id : null;
  const agora = new Date();

  // ── 1. O menu só fala se estiver ligado nas configurações da empresa ──────
  const { data: org, error: erroOrg } = await ctx.admin
    .from("organizations")
    .select("settings")
    .eq("id", ctx.organizationId)
    .maybeSingle();
  if (erroOrg) return pulo("settings_indisponivel");
  const settings = (org?.settings ?? {}) as {
    menu?: { enabled?: boolean };
    agenda_online?: { enabled?: boolean };
  };
  if (settings.menu?.enabled !== true) return pulo("menu_desligado");

  // ── 2. O contato (lido AQUI — ruling: erro ≠ sem linha) e as travas ───────
  const { data: contatoRow, error: erroContato } = await ctx.admin
    .from("contacts")
    .select("force_human, ai_opt_out, is_blocked, is_personal")
    .eq("id", contactId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (erroContato) return pulo("contato_indisponivel"); // falha fechada: nunca `null` pós-erro
  const contact =
    contatoRow === null
      ? null
      : (contatoRow as {
          force_human?: boolean;
          ai_opt_out?: boolean;
          is_blocked?: boolean;
          is_personal?: boolean;
        });
  if (await bloqueioHumano(ctx.admin, ctx.organizationId, conversationId, contact, agora)) {
    return pulo("bloqueio_humano");
  }

  // ── 3. R1/R2: a IA (ou o roteador dela) comanda; o menu sai de perto ──────
  if (await iaResponderiaASessao(ctx.admin, ctx.organizationId, sessionId, conversationId, agora)) {
    return pulo("ia_responderia");
  }

  // ── 4. A sessão do contato e o cardápio ativo da organização ──────────────
  const { data: sessaoRow, error: erroSessao } = await ctx.admin
    .from("menu_sessoes")
    .select("estado, dados")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .maybeSingle();
  if (erroSessao) return pulo("menu_sessao_indisponivel");
  const { data: itensRows, error: erroItens } = await ctx.admin
    .from("menu_itens")
    .select("ordem, rotulo, tipo, resposta_texto, consulta")
    .eq("organization_id", ctx.organizationId)
    .eq("ativo", true)
    .order("ordem");
  if (erroItens) return pulo("menu_itens_indisponivel");

  const estado = (typeof sessaoRow?.estado === "string" ? sessaoRow.estado : "idle") as Estado;
  const dados =
    sessaoRow?.dados !== null &&
    sessaoRow?.dados !== undefined &&
    typeof sessaoRow.dados === "object"
      ? (sessaoRow.dados as Record<string, unknown>)
      : {};
  const itens: ItemDoMenu[] = (itensRows ?? []).map((r) => ({
    ordem: typeof r.ordem === "number" ? r.ordem : Number(r.ordem),
    rotulo: String(r.rotulo ?? ""),
    tipo: r.tipo === "consulta" ? ("consulta" as const) : ("texto" as const),
    resposta_texto: typeof r.resposta_texto === "string" ? r.resposta_texto : null,
    consulta: typeof r.consulta === "string" ? r.consulta : null,
  }));

  // ── 5. O contexto — serviços e disponibilidade, sempre pela régua da casa ─
  const { data: tiposRows, error: erroTipos } = await ctx.admin
    .from("calendar_event_types")
    .select("id, name, duration_minutes, default_price_cents")
    .eq("organization_id", ctx.organizationId)
    .eq("is_active", true)
    .order("name");
  const servicos: ServicoDoMenu[] = (erroTipos ? [] : (tiposRows ?? [])).map((t) => ({
    event_type_id: String(t.id),
    nome: String(t.name ?? ""),
    duracao_min: Number(t.duration_minutes ?? 0),
    preco_cents:
      t.default_price_cents === null || t.default_price_cents === undefined
        ? null
        : Number(t.default_price_cents),
  }));
  const disponibilidade = await montarDisponibilidade(
    ctx.admin,
    ctx.organizationId,
    servicos,
    estado,
    dados,
    corpo,
    agora,
  );

  // ── 6. A máquina decide; resposta nula é pulo ─────────────────────────────
  const saida = proximoPasso(
    { estado, dados, texto: corpo },
    { servicos, ...disponibilidade, itens },
  );
  if (saida.resposta === null) return pulo("sem_resposta");

  // ── 7+8. Enviar; estado só avança se o envio foi ACEITO ───────────────────
  try {
    const boundary = await serviceForAutomation(ctx, contactId, sessionId);
    await espacarEnvio(sessionId);
    const message = await sendMessageHandler(
      ctx.admin,
      {
        organization_id: ctx.organizationId,
        serviceBoundary: boundary,
        actor: { type: "webhook_source", id: ctx.ruleId },
        requestId: `rule:${ctx.ruleId}`,
      },
      { conversation_id: boundary.conversation_id, type: "text", body: saida.resposta ?? "" },
    );
    const desfecho = await reportarEnvio(
      ctx,
      TIPO,
      message as unknown as MensagemEnviada,
      boundary.conversation_id,
    );
    // Review Focus 3: `failed` (recusa do handler), `postponed` (fila) ou
    // qualquer coisa que não seja `sent` → o passo NÃO avança. O cliente não
    // viu a resposta, então a máquina continua de onde estava — a próxima
    // mensagem reprocessa do mesmo estado, sem buraco e sem passo fantasma.
    if (desfecho.status !== "success") return desfecho;

    const { error: erroGravacao } = await ctx.admin.from("menu_sessoes").upsert(
      {
        organization_id: ctx.organizationId,
        contact_id: contactId,
        estado: saida.estado,
        dados: saida.dados,
      },
      { onConflict: "organization_id,contact_id" },
    );
    if (erroGravacao) {
      // A mensagem saiu e o estado não gravou: dizer sucesso esconderia uma
      // máquina fora de sincronia (próxima mensagem reprocessaria o passo).
      return { type: TIPO, status: "failed", error: "menu_sessao_nao_gravada" };
    }
    return desfecho;
  } catch (err) {
    // Recusa na frente (janela fechada, boundary, validação do handler): o
    // mesmo canal honesto de `send-whatsapp` — failed com a causa legível.
    return { type: TIPO, status: "failed", error: mensagemDeErro(err) };
  }
}

registerAction({ type: TIPO, execute });
