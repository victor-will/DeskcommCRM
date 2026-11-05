import { marcarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { diaLocalISO, instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { horariosLivresDaOrg } from "@/lib/agenda/consulta";
import { registerAction } from "@/lib/automation/actions";
import { mensagemDeErro } from "@/lib/automation/actions/erro-legivel";
import { reportarEnvio, type MensagemEnviada } from "@/lib/automation/desfecho-do-envio";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
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
 * 1. `organizations.settings.menu.enabled !== true` → `skipped`; o MESMO com
 *    `concedido !== true` (`sem_concessao` — revogar mata o menu) e com as
 *    guardas compartilhadas do contato (`checarGuardasDeContato`, inclusive
 *    `consent_declined`) → `skipped`;
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
 * 6.5. **se o passo final devolveu `agendamento`**: a RESERVA roda ANTES de
 *    qualquer texto sair — `marcarAgendamentoHandler`, a função que REST e MCP
 *    já chamam (a régua de horário livre é dela, B8), com a hora de parede da
 *    máquina CONVERTIDA para instante pelo fuso da jornada (`instanteDe`).
 *    Reserva falhou → o cliente recebe "Não consegui marcar esse horário…",
 *    NUNCA o "Agendado!";
 * 7. envio pelo MESMO caminho de `send-whatsapp.ts` (serviceForAutomation →
 *    espacarEnvio → `sendMessageHandler` com `actor {type:"webhook_source"}` e
 *    `requestId "rule:<id>"` → `reportarEnvio`) — sem reimplementar janela,
 *    pacing ou cap;
 * 8. **estado avança com a régua combinada**: sem reserva, só em `success`
 *    (Review Focus 3); com reserva FEITA, avança mesmo se o envio for
 *    recusado (exceção pinada: a reserva é o fato que importa — não avançar
 *    deixaria o cliente re-escolher o mesmo slot numa corrida contra a reserva
 *    que já existe); com reserva FALHOU, nunca avança;
 * 9. sem `audit()`: o motor já registra `automation_rule_runs`.
 *
 * ─── A disponibilidade e a "uma chamada" do brief ───────────────────────────
 *
 * A função é POR TIPO DE SERVIÇO (`eventTypeId` obrigatório — medido em
 * `lib/agenda/consulta.ts`). Onde o serviço está determinado, é EXATAMENTE
 * uma chamada: escolha da tecla em `aguardando_servico` (pré-leitura do número
 * — quem VALIDA e transiciona continua sendo a máquina), serviço já gravado em
 * `dados` nos passos `aguardando_dia`/`aguardando_horario`. A única exceção é
 * a consulta `horários de hoje` no `menu`, resolvida PELA ORDEM DO ITEM (a
 * mesma chave com que a máquina resolve a tecla — `menu_itens` pode ser
 * renumerado; tecla 1 só no cardápio G4, sem itens): sem serviço na mão aí é
 * a união dos ativos, uma chamada POR serviço — a régua continua sendo a da
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
 *
 * No `menu` a tecla é resolvida COMO a máquina resolve — pela `ordem` do item
 * em `itens` (renumerar `horarios_hoje` de 1 para 4 tem de continuar
 * buscando), e só item de consulta `horarios_hoje` (ou a tecla 1 do G4, sem
 * itens no banco) dispara a união.
 */
function alvosDaDisponibilidade(
  servicos: readonly ServicoDoMenu[],
  estado: Estado,
  dados: Record<string, unknown>,
  corpo: string,
  itens: readonly ItemDoMenu[] | undefined,
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
  if (estado === "menu" && n !== null) {
    const temItens = itens !== undefined && itens.length > 0;
    if (temItens) {
      const item = itens.find((i) => i.ordem === n);
      const ehHorariosDeHoje = item?.tipo === "consulta" && item.consulta === "horarios_hoje";
      return ehHorariosDeHoje ? servicos.map((s) => s.event_type_id) : [];
    }
    // Cardápio G4: a tecla fixa 1 é a de "Horários de hoje".
    return n === 1 ? servicos.map((s) => s.event_type_id) : [];
  }
  return [];
}

interface Disponibilidade {
  diasComVaga: Array<{ data: string; rotulo: string }>;
  horariosDoDia: string[];
  /** O fuso da JORNADA que serviu os slots — é ele que converte a parede da máquina em instante na reserva. */
  fuso: string | null;
}

/**
 * Dias com vaga (agrupados por dia LOCAL DA REGRA — `diaLocalISO` com o
 * `fusoDaRegra` que a própria consulta devolve) e os horários do dia que o
 * passo atual vai mostrar: o escolhido pela tecla em `aguardando_dia`, o de
 * `dados.dia` em `aguardando_horario`, e senão os de HOJE (a consulta 1).
 */
async function montarDisponibilidade(
  admin: ActionCtx["admin"],
  orgId: string,
  servicos: readonly ServicoDoMenu[],
  estado: Estado,
  dados: Record<string, unknown>,
  corpo: string,
  itens: readonly ItemDoMenu[] | undefined,
  agora: Date,
): Promise<Disponibilidade> {
  const alvos = alvosDaDisponibilidade(servicos, estado, dados, corpo, itens);
  if (alvos.length === 0) return { diasComVaga: [], horariosDoDia: [], fuso: null };

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
    fuso,
  };
}

/**
 * `"2026-11-07T09:30:00"` (hora de parede da máquina, SEM fuso — contrato da
 * Task 3) → o INSTANTE no fuso da jornada que ofereceu o horário.
 *
 * `new Date(parede)` aqui leria o fuso do SERVIDOR e marcaria 3h do lado errado
 * numa VPS em UTC — é o `instanteDe` de `lib/agenda/fuso.ts` (a mesma régua de
 * parede→instante da rota e do MCP) que resolve, com as bordas de horário de
 * verão tratadas. `null` quando não dá para converter com segurança (fuso
 * ausente ou forma inesperada): nesse caso a reserva NÃO acontece e o cliente
 * recebe a frase de falha — nunca "Agendado!".
 */
function paraInstante(parede: string, fuso: string | null): Date | null {
  const p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(parede);
  if (p === null || fuso === null) return null;
  return instanteDe(
    {
      ano: Number(p[1]),
      mes: Number(p[2]),
      dia: Number(p[3]),
      hora: Number(p[4]),
      minuto: Number(p[5]),
      segundo: Number(p[6]),
    },
    fuso,
  );
}

/** A frase exata quando a casa recusa a reserva (ruling fix round 1). */
const MSG_FALHA_RESERVA =
  "Não consegui marcar esse horário — pode já estar ocupado. Escolha outro.";

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
    menu?: { enabled?: boolean; concedido?: boolean };
    agenda_online?: { enabled?: boolean };
  };
  if (settings.menu?.enabled !== true) return pulo("menu_desligado");
  // ── Revogação mata o menu (achado da revisão) ─────────────────────────────
  // `enabled` sozinho não basta: a rota admin revoga escrevendo só
  // `concedido:false` (e a camada de plano pode sumir dos `recursos` sem
  // tocar no toggle). Sem esta trava, o menu continuava respondendo com a
  // tela já dizendo "Aguardando ativação".
  if (settings.menu?.concedido !== true) return pulo("sem_concessao");

  // ── Guardas COMPARTILHADAS (irmã de send-whatsapp) ───────────────────────
  // Mesmas 4 de `lib/automation/guarda-do-contato.ts` — inclusive o
  // consentimento (`consent_declined`: "quem disse não me mande mensagem,
  // não"), invariante de conformidade em código e não em config. Barata (lê
  // `ctx.context.contact`, hidratado pelo buildContext) e ANTES de qualquer
  // leitura/avanço de sessão: se bloqueia, é pulo — a máquina não anda.
  const guarda = checarGuardasDeContato(ctx);
  if (!guarda.ok) return pulo(guarda.reason);

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
    itens,
    agora,
  );

  // ── 6. A máquina decide; resposta nula é pulo ─────────────────────────────
  const saida = proximoPasso(
    { estado, dados, texto: corpo },
    {
      servicos,
      diasComVaga: disponibilidade.diasComVaga,
      horariosDoDia: disponibilidade.horariosDoDia,
      itens,
    },
  );
  if (saida.resposta === null) return pulo("sem_resposta");

  // ── 6.5. A RESERVA vem ANTES do "Agendado!" sair (spec §6.1 P5: gravar
  // pela mesma régua — B8: a régua de horário livre é da casa, nunca
  // reimplementada). A função é `marcarAgendamentoHandler`, a MESMA que rota e
  // MCP chamam; ela revalida horário livre com a duração do tipo internamente.
  // Entrada mínima: o que a máquina devolveu + org do contexto + contato do
  // payload (ruling: nada de campo inventado).
  let reservou = false;
  let texto = saida.resposta;
  if (saida.agendamento !== undefined) {
    const instante = paraInstante(saida.agendamento.starts_at, disponibilidade.fuso);
    if (instante === null) {
      // Sem como converter com segurança não se marca nada — e nunca se
      // promete "Agendado!" no escuro.
      texto = MSG_FALHA_RESERVA;
    } else {
      try {
        await marcarAgendamentoHandler(
          ctx.admin,
          {
            organization_id: ctx.organizationId,
            actor: { type: "webhook_source", id: ctx.ruleId },
            requestId: `rule:${ctx.ruleId}`,
          },
          {
            event_type_id: saida.agendamento.event_type_id,
            starts_at: instante.toISOString(),
            contact_id: contactId,
            // O MESMO campo que a rota REST passa (agendamentos/route.ts:115):
            // sem ele o agendamento nascia órfão da conversa — o boundary do
            // booking e o `fecharOLaco` leem `input.conversation_id`. O tipo é
            // `conversation_id?: string` (sem null) — ausente vira `undefined`.
            conversation_id: conversationId ?? undefined,
          },
        );
        reservou = true;
      } catch {
        // Horário tomado entre a leitura e a escrita, tipo desativado, jornada
        // mudou: a recusa da casa vira a frase do cliente, e o passo NÃO
        // avança — ele escolhe outro horário.
        texto = MSG_FALHA_RESERVA;
      }
    }
  }

  // ── 7+8. Enviar, e avançar o estado pela régua combinada ─────────────────
  const salvar = async (): Promise<ActionResultDetail | null> => {
    const { error } = await ctx.admin.from("menu_sessoes").upsert(
      {
        organization_id: ctx.organizationId,
        contact_id: contactId,
        estado: saida.estado,
        dados: saida.dados,
      },
      { onConflict: "organization_id,contact_id" },
    );
    // A mensagem saiu e o estado não gravou: dizer sucesso esconderia uma
    // máquina fora de sincronia (próxima mensagem reprocessaria o passo).
    return error ? { type: TIPO, status: "failed", error: "menu_sessao_nao_gravada" } : null;
  };

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
      { conversation_id: boundary.conversation_id, type: "text", body: texto },
    );
    const desfecho = await reportarEnvio(
      ctx,
      TIPO,
      message as unknown as MensagemEnviada,
      boundary.conversation_id,
    );

    // A régua do passo 8, com as EXCEÇÕES pinadas no fix round 1:
    //  - passo SEM reserva: só `success` avança — o cliente não viu a resposta,
    //    então a máquina fica onde estava (Review Focus 3);
    //  - reserva FEITA: avança MESMO com envio recusado — a reserva é o fato
    //    que importa, e não avançar deixaria o cliente re-escolher o MESMO
    //    slot numa corrida contra a reserva que já existe no banco;
    //  - reserva FALHOU: nunca avança, mesmo que o texto de falha tenha saído.
    const deveSalvar =
      reservou || (desfecho.status === "success" && saida.agendamento === undefined);
    if (deveSalvar) {
      const falha = await salvar();
      if (falha) return falha;
    }
    if (saida.agendamento !== undefined && !reservou) {
      // O texto de falha pode ter sido entregue com sucesso — o run guarda a
      // marca de que a RESERVA falhou, que é o fato que a aba Atividade lê.
      return { ...desfecho, detail: { ...(desfecho.detail ?? {}), reserva: "falhou" } };
    }
    return desfecho;
  } catch (err) {
    // Recusa na frente (janela fechada, boundary, validação do handler): o
    // mesmo canal honesto de `send-whatsapp` — failed com a causa legível.
    if (reservou) {
      // EXCEÇÃO PINADA (fix round 1): reserva criada + envio recusado → o
      // estado AVANÇA mesmo assim (a régua acima); sem isto o próximo "2" do
      // cliente re-escolheria o slot que JÁ está marcado.
      const falha = await salvar();
      if (falha) return falha;
    }
    return { type: TIPO, status: "failed", error: mensagemDeErro(err) };
  }
}

registerAction({ type: TIPO, execute });
