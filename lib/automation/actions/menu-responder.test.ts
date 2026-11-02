import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx } from "@/lib/automation/types";

/**
 * `menu_responder` — a ação que faz o menu de texto falar (spec §6.1, fluxo
 * travado 1–9 da Task 5).
 *
 * ─── O que cada caso mede ───────────────────────────────────────────────────
 *
 * Os 8 casos com nome vêm do brief (verbatim); os extras cobrem o registro no
 * motor + o schema (molde de `notify-team.test.ts`) e a ponte
 * `menu_itens → contexto.itens` (ruling da Task 5, lado da ação).
 *
 * As travas de convivência (silêncio/atribuição/opt-out/IA) rodam POR CIMA —
 * `bloqueioHumano` e `iaResponderiaASessao` reais, contra o banco falso —
 * defesa em profundidade mesmo com as guardas do motor (decisão travada).
 *
 * O SENDO é o caminho de `send-whatsapp.ts` linha a linha: serviceForAutomation
 * → espacarEnvio → `sendMessageHandler` com `actor {type:"webhook_source"}` e
 * `requestId "rule:<id>"` → `reportarEnvio`. E a regra do Review Focus 3 mora
 * aqui: estado só avança quando o desfecho é `success` (nada de recusar
 * janela/pacing/cap e deixar a máquina andado).
 */

const mocks = vi.hoisted(() => ({
  sendMessageHandler: vi.fn(async (): Promise<{ id: string; status: string }> => ({
    id: "msg-1",
    status: "sent",
  })),
  serviceForAutomation: vi.fn(async () => ({ conversation_id: "conv-1" })),
  espacarEnvio: vi.fn(async () => undefined),
  horariosLivresDaOrg: vi.fn(),
  marcarAgendamentoHandler: vi.fn(async (): Promise<Record<string, unknown>> => ({
    id: "ap-1",
    status: "confirmed",
  })),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.sendMessageHandler }));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: mocks.serviceForAutomation,
}));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: mocks.espacarEnvio }));
vi.mock("@/lib/agenda/consulta", () => ({ horariosLivresDaOrg: mocks.horariosLivresDaOrg }));
// A reserva é a função compartilhada da casa (REST + MCP chegam nela) — a rota
// não muda; aqui só o chamador é dublado para fixar argumentos e recusas.
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: mocks.marcarAgendamentoHandler,
}));

import { getAction } from "@/lib/automation/actions";
// Import isolado: registra a ação pelo mesmo caminho do register-all.
import "@/lib/automation/actions/menu-responder";
import { actionSchema } from "@/lib/schemas/webhooks";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";

/** Silêncio do humano ainda no futuro — o relógio do teste é o do runtime. */
const SILENCIO_VIGENTE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

type Linha = Record<string, unknown>;

/**
 * O recorte do PostgREST que a ação E as travas usam: select/eq/is/not/in/
 * order/limit/insert/upsert + maybeSingle e o await direto do builder, com
 * caminho pontilhado no embutido (`ai_agent_versions.status`) — molde do
 * `bancoFalso` de `lib/automation`, estendido pelo que o fluxo pede.
 */
function adminFake(
  tabelas: Record<string, Linha[]>,
  opcoes: { comErroEm?: readonly string[] } = {},
): { admin: ActionCtx["admin"]; consultadas: Set<string>; tabelas: Record<string, Linha[]> } {
  const consultadas = new Set<string>();

  const caminho = (linha: Linha, coluna: string): unknown =>
    coluna
      .split(".")
      .reduce<unknown>(
        (atual, parte) =>
          atual !== null && typeof atual === "object" ? (atual as Linha)[parte] : undefined,
        linha,
      );

  function builder(tabela: string) {
    consultadas.add(tabela);
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const nulos: string[] = [];
    const naoNulos: string[] = [];

    const linhas = () =>
      (tabelas[tabela] ?? []).filter(
        (l) =>
          eqs.every(([c, v]) => caminho(l, c) === v) &&
          ins.every(([c, vs]) => vs.includes(caminho(l, c))) &&
          nulos.every((c) => caminho(l, c) === null || caminho(l, c) === undefined) &&
          naoNulos.every((c) => caminho(l, c) !== null && caminho(l, c) !== undefined),
      );

    const erro =
      opcoes.comErroEm?.includes(tabela) === true ? { message: "leitura recusada" } : null;
    const resposta = () =>
      erro !== null ? { data: null, error: erro } : { data: linhas(), error: null };
    const respostaUnica = () =>
      erro !== null ? { data: null, error: erro } : { data: linhas()[0] ?? null, error: null };

    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => {
        eqs.push([c, v]);
        return q;
      },
      in: (c: string, vs: unknown[]) => {
        ins.push([c, vs]);
        return q;
      },
      is: (c: string, v: unknown) => {
        if (v === null) nulos.push(c);
        return q;
      },
      not: (c: string, op: string, v: unknown) => {
        if (op === "is" && v === null) naoNulos.push(c);
        return q;
      },
      order: () => q,
      limit: () => q,
      gte: () => q,
      insert: () => q,
      upsert: (payload: Linha) => {
        const linhas = tabelas[tabela] ?? [];
        const org = payload.organization_id;
        const contato = payload.contact_id;
        const alvo =
          org !== undefined && contato !== undefined
            ? linhas.find((l) => l.organization_id === org && l.contact_id === contato)
            : undefined;
        if (alvo !== undefined) Object.assign(alvo, payload);
        else linhas.push({ ...payload });
        return q;
      },
      maybeSingle: async () => respostaUnica(),
      then: (
        ok: (r: { data: Linha[] | null; error: { message: string } | null }) => unknown,
        ra?: (e: unknown) => unknown,
      ) => Promise.resolve(resposta()).then(ok, ra),
    };
    return q;
  }

  return {
    admin: { from: builder } as unknown as ActionCtx["admin"],
    consultadas,
    // O MESMO objeto que o `upsert` muta — é por isto que conferir a linha
    // depois do execute mede o que foi gravado, e não uma cópia.
    tabelas,
  };
}

/** O mundo em que o menu funciona: settings ligado, contato limpo, 2 serviços. */
function mundo(overrides: Record<string, Linha[]> = {}): Record<string, Linha[]> {
  return {
    organizations: [
      { id: ORG, settings: { menu: { enabled: true }, agenda_online: { enabled: false } } },
    ],
    contacts: [
      {
        id: CONTATO,
        organization_id: ORG,
        force_human: false,
        ai_opt_out: false,
        is_blocked: false,
        is_personal: false,
      },
    ],
    conversations: [],
    menu_sessoes: [],
    menu_itens: [],
    calendar_event_types: [
      {
        id: "et-corte",
        organization_id: ORG,
        name: "Corte",
        duration_minutes: 30,
        default_price_cents: 5000,
        is_active: true,
      },
      {
        id: "et-escova",
        organization_id: ORG,
        name: "Escova",
        duration_minutes: 20,
        default_price_cents: 3000,
        is_active: true,
      },
    ],
    ai_agents: [],
    ai_routers: [],
    ai_router_members: [],
    ai_provider_credentials: [],
    ...overrides,
  };
}

function sessao(estado: string, dados: Record<string, unknown> = {}): Linha {
  return { organization_id: ORG, contact_id: CONTATO, estado, dados };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organization_id: ORG,
    contact_id: CONTATO,
    channel_session_id: SESSAO,
    conversation_id: CONVERSA,
    body_preview: "oi",
    ...overrides,
  };
}

function ctx(admin: ActionCtx["admin"], corpo: Record<string, unknown> = payload()): ActionCtx {
  return {
    admin,
    organizationId: ORG,
    ruleId: "rule-1",
    ruleName: "Menu do WhatsApp",
    event: { event_type: "message.received", payload: corpo } as unknown as ActionCtx["event"],
    context: {},
    requestId: "req-1",
  };
}

/** A consulta de agenda devolvida quando há vaga (molde: shape de ResultadoDaConsulta). */
function comVaga(): void {
  mocks.horariosLivresDaOrg.mockResolvedValue({
    ok: true,
    slots: [
      { inicio: new Date("2026-11-03T09:00:00Z"), fim: new Date("2026-11-03T09:30:00Z") },
      { inicio: new Date("2026-11-03T10:00:00Z"), fim: new Date("2026-11-03T10:30:00Z") },
    ],
    fusoDaRegra: "America/Sao_Paulo",
    publicouHorarios: true,
    fusoSuposto: false,
    fontesDefasadas: [],
    agendaExternaNuncaLida: false,
    googleCoberturaParcial: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendMessageHandler.mockResolvedValue({ id: "msg-1", status: "sent" });
  mocks.serviceForAutomation.mockResolvedValue({ conversation_id: "conv-1" });
  mocks.espacarEnvio.mockResolvedValue(undefined);
  mocks.marcarAgendamentoHandler.mockResolvedValue({ id: "ap-1", status: "confirmed" });
});

describe("menu_responder — registro e schema", () => {
  it("está registrada no motor, pelo mesmo registry das irmãs", () => {
    const acao = getAction("menu_responder");
    expect(
      acao,
      "menu_responder não foi registrada — ver lib/automation/actions/register-all.ts",
    ).toBeTruthy();
  });

  it("aceita a configuração mínima `{}` (schema fechado do brief)", () => {
    expect(actionSchema.safeParse({ type: "menu_responder", config: {} }).success).toBe(true);
    expect(actionSchema.safeParse({ type: "menu_responder" }).success).toBe(true);
  });
});

describe("menu_responder — as travas antes de qualquer resposta", () => {
  it("menu desligado no settings: skipped sem tocar no banco de sessao", async () => {
    const { admin, consultadas } = adminFake(mundo({ organizations: [{ id: ORG, settings: {} }] }));
    const r = await getAction("menu_responder")!.execute(ctx(admin), {});
    expect(r.status).toBe("skipped");
    expect(r.detail?.reason).toBe("menu_desligado");
    expect(consultadas.has("menu_sessoes")).toBe(false);
    expect(mocks.sendMessageHandler).not.toHaveBeenCalled();
    expect(mocks.horariosLivresDaOrg).not.toHaveBeenCalled();
  });

  it("bloqueio humano: skipped", async () => {
    // Silêncio vigente do humano (R4/Review Focus 4) — cala o menu mesmo com
    // estado de menu ativo.
    const { admin, tabelas } = adminFake(
      mundo({
        conversations: [
          {
            id: CONVERSA,
            organization_id: ORG,
            bot_silenced_until: SILENCIO_VIGENTE,
            assignee_kind: null,
          },
        ],
        menu_sessoes: [sessao("menu")],
      }),
    );
    const r = await getAction("menu_responder")!.execute(ctx(admin), {});
    expect(r.status).toBe("skipped");
    expect(r.detail?.reason).toBe("bloqueio_humano");
    expect(mocks.sendMessageHandler).not.toHaveBeenCalled();
    // Travou antes do passo 4: a sessão não foi lida nem regravada — o
    // estado na tabela continua exatamente o de antes.
    expect(tabelas.menu_sessoes?.[0]?.estado).toBe("menu");
  });

  it("IA responderia: skipped (R1)", async () => {
    // Agente publicado NESTA sessão + credencial validada → a IA comanda.
    const { admin, tabelas } = adminFake(
      mundo({
        ai_agents: [
          {
            id: "ag-1",
            organization_id: ORG,
            archived_at: null,
            paused_at: null,
            ai_agent_versions: { status: "published", channel_session_id: SESSAO },
          },
        ],
        ai_provider_credentials: [
          {
            id: "cred-1",
            organization_id: ORG,
            is_active: true,
            validated_at: "2026-10-01T10:00:00.000Z",
          },
        ],
        menu_sessoes: [sessao("menu")],
      }),
    );
    const r = await getAction("menu_responder")!.execute(ctx(admin), {});
    expect(r.status).toBe("skipped");
    expect(r.detail?.reason).toBe("ia_responderia");
    expect(mocks.sendMessageHandler).not.toHaveBeenCalled();
    // Travou no passo 3: a sessão nem foi lida, e muito menos regravada.
    expect(tabelas.menu_sessoes?.[0]?.estado).toBe("menu");
  });

  it("opt-out/bloqueado nao envia (Review Focus 2)", async () => {
    for (const flag of ["ai_opt_out", "is_blocked"] as const) {
      const { admin } = adminFake(
        mundo({
          contacts: [
            {
              id: CONTATO,
              organization_id: ORG,
              force_human: false,
              ai_opt_out: false,
              is_blocked: false,
              is_personal: false,
              [flag]: true,
            },
          ],
        }),
      );
      const r = await getAction("menu_responder")!.execute(ctx(admin), {});
      expect(r.status, flag).toBe("skipped");
      expect(r.detail?.reason, flag).toBe("bloqueio_humano");
      expect(mocks.sendMessageHandler, flag).not.toHaveBeenCalled();
    }
  });

  it("body_preview vazio (midia): skipped", async () => {
    const { admin, consultadas } = adminFake(mundo());
    const r = await getAction("menu_responder")!.execute(
      ctx(admin, payload({ body_preview: "" })),
      {},
    );
    expect(r.status).toBe("skipped");
    expect(r.detail?.reason).toBe("corpo_vazio");
    // Nenhuma leitura nenhuma: nem settings, nem sessão, nem agenda.
    expect(consultadas.size).toBe(0);
    expect(mocks.sendMessageHandler).not.toHaveBeenCalled();
  });
});

describe("menu_responder — responde, grava e só avança com envio aceito", () => {
  it("idle recebeu texto: responde o menu e grava estado menu", async () => {
    const { admin } = adminFake(mundo());
    const r = await getAction("menu_responder")!.execute(ctx(admin), {});

    expect(r.status).toBe("success");
    expect(mocks.serviceForAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.espacarEnvio).toHaveBeenCalledWith(SESSAO);
    expect(mocks.sendMessageHandler).toHaveBeenCalledTimes(1);

    const [, cabecalho, mensagem] = mocks.sendMessageHandler.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
      { conversation_id: string; type: string; body: string },
    ];
    // O mesmo formato de send-whatsapp.ts linhas 101-121 (ruling 4).
    expect(cabecalho.actor).toEqual({ type: "webhook_source", id: "rule-1" });
    expect(cabecalho.requestId).toBe("rule:rule-1");
    expect(mensagem.type).toBe("text");
    expect(mensagem.conversation_id).toBe("conv-1");
    expect(mensagem.body).toContain("1 — Horários de hoje");
    expect(mensagem.body).toContain("0 — Falar com alguém");

    // Passo 8: grava a sessão com o novo estado (e nada de consulta de agenda
    // num menu de idle — a consulta sai de graça).
    expect(mocks.horariosLivresDaOrg).not.toHaveBeenCalled();
  });

  it("sessao aguardando servico com escolha valida: avanca e grava", async () => {
    comVaga();
    const { admin, consultadas, tabelas } = adminFake(
      mundo({ menu_sessoes: [sessao("aguardando_servico")] }),
    );
    const r = await getAction("menu_responder")!.execute(
      ctx(admin, payload({ body_preview: "1" })),
      {},
    );

    expect(r.status).toBe("success");
    // Uma consulta de agenda, para o SERVIÇO ESCOLHIDO (a pré-leitura da tecla
    // escolhe a régua; quem valida e transiciona é a máquina).
    expect(mocks.horariosLivresDaOrg).toHaveBeenCalledTimes(1);
    const params = mocks.horariosLivresDaOrg.mock.calls[0]![2] as {
      eventTypeId?: string;
      de?: Date;
      ate?: Date;
    };
    expect(params.eventTypeId).toBe("et-corte");

    const chamada = mocks.sendMessageHandler.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { body: string },
    ];
    expect(chamada[2].body).toContain("ter 03/11"); // 2026-11-03 é terça (02/11 é segunda)

    // Passo 8: avançou de estado e gravou a escolha do serviço.
    const linha = tabelas.menu_sessoes?.[0];
    expect(linha?.estado).toBe("aguardando_dia");
    expect((linha?.dados as Record<string, unknown>).servico_event_type_id).toBe("et-corte");
    expect(consultadas.has("menu_sessoes")).toBe(true);
  });

  it("envio recusado pela janela: estado NAO avanca (Review Focus 3)", async () => {
    // O recusa na frente (ApiError `janela_fechada`, o formato do handler) —
    // e a máquina tem de continuar onde estava.
    mocks.sendMessageHandler.mockRejectedValueOnce({
      message: "Janela de 24 horas fechada: texto livre é recusado pela plataforma (131047).",
      code: "janela_fechada",
    });
    const { admin, tabelas } = adminFake(mundo({ menu_sessoes: [sessao("aguardando_servico")] }));

    const r = await getAction("menu_responder")!.execute(
      ctx(admin, payload({ body_preview: "1" })),
      {},
    );
    expect(r.status).toBe("failed");
    expect(r.error).toContain("janela_fechada");

    // O estado na tabela é o MESMO de antes — nenhum upsert de passo.
    const linha = tabelas.menu_sessoes?.[0];
    expect(linha?.estado).toBe("aguardando_servico");
    expect(linha?.dados).toEqual({});
  });

  it("item customizado do banco vira resposta da maquina (ponte menu_itens → contexto.itens)", async () => {
    const { admin, tabelas } = adminFake(
      mundo({
        menu_sessoes: [sessao("menu")],
        menu_itens: [
          {
            organization_id: ORG,
            ativo: true,
            ordem: 7,
            rotulo: "Cardápio",
            tipo: "texto",
            resposta_texto: "Nosso cardápio: cortes e escovas, das 9h às 18h.",
            consulta: null,
          },
        ],
      }),
    );
    const r = await getAction("menu_responder")!.execute(
      ctx(admin, payload({ body_preview: "7" })),
      {},
    );
    expect(r.status).toBe("success");
    const chamada = mocks.sendMessageHandler.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { body: string },
    ];
    expect(chamada[2].body).toBe("Nosso cardápio: cortes e escovas, das 9h às 18h.");
    const linha = tabelas.menu_sessoes?.[0];
    expect(linha?.estado).toBe("menu");
  });
});

/**
 * Fix round 1 (review "Needs fixes"):
 *
 * 1. O `agendamento` do passo final É reservado — pela função compartilhada da
 *    casa (`marcarAgendamentoHandler`, a mesma do REST e do MCP; B8: a régua
 *    de horário livre é dela, nunca reimplementada), ANTES do "Agendado!" sair.
 *    Reserva falhou → frase própria, passo não avança; reserva FEITA + envio
 *    recusado → o estado AVANÇA (exceção pinada: a reserva é o fato que
 *    importa, e não avançar deixaria o cliente re-escolher o mesmo slot).
 *
 * 2. A pré-leitura de disponibilidade resolve a tecla COMO a máquina resolve —
 *    pela `ordem` do item, não pela tecla fixa 1 (renumerar `horarios_hoje`
 *    para a ordem 4 tem de continuar buscando os horários; tecla 1 mapeada a
 *    item de texto não tem de gastar consulta de agenda).
 */
describe("fix round 1 — reserva pela regua da casa e tecla resolvida por item", () => {
  /** O passo final: serviço e dia já escolhidos e gravados na sessão. */
  function sessaoNoPassoFinal(): Linha {
    return sessao("aguardando_horario", {
      servico_event_type_id: "et-corte",
      servico_nome: "Corte",
      dia: "2026-11-07",
    });
  }

  /** Slots de 07/11/2026 (sábado) às 09:30 no fuso da régua — o horário escolhido. */
  function comVagaEm07DeNovembro(): void {
    mocks.horariosLivresDaOrg.mockResolvedValue({
      ok: true,
      slots: [
        {
          inicio: new Date("2026-11-07T12:30:00.000Z"),
          fim: new Date("2026-11-07T13:00:00.000Z"),
        },
      ],
      fusoDaRegra: "America/Sao_Paulo",
      publicouHorarios: true,
      fusoSuposto: false,
      fontesDefasadas: [],
      agendaExternaNuncaLida: false,
      googleCoberturaParcial: false,
    });
  }

  it("reserva final: cria pela regua da casa, envia o 'Agendado!' e avanca", async () => {
    comVagaEm07DeNovembro();
    const { admin, tabelas } = adminFake(mundo({ menu_sessoes: [sessaoNoPassoFinal()] }));
    const r = await getAction("menu_responder")!.execute(
      ctx(admin, payload({ body_preview: "1" })),
      {},
    );
    expect(r.status).toBe("success");

    expect(mocks.marcarAgendamentoHandler).toHaveBeenCalledTimes(1);
    const [adminChamado, agendaCtx, entrada] = mocks.marcarAgendamentoHandler.mock
      .calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
      { event_type_id: string; starts_at: string; contact_id: string },
    ];
    expect(adminChamado).toBe(admin);
    // O mesmo formato da rota/MCP: org do contexto, actor da origem, requestId.
    expect(agendaCtx).toEqual({
      organization_id: ORG,
      actor: { type: "webhook_source", id: "rule-1" },
      requestId: "rule:rule-1",
    });
    // Hora de parede da máquina (09:30) CONVERTIDA para o instante do fuso da
    // régua (America/Sao_Paulo = 12:30Z) — o contrato da Task 5 ("quem converte
    // é a Task 5, com `instanteDe`") e a forma que rota e MCP exigem (offset).
    expect(entrada).toEqual({
      event_type_id: "et-corte",
      starts_at: "2026-11-07T12:30:00.000Z",
      contact_id: CONTATO,
    });

    const chamada = mocks.sendMessageHandler.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { body: string },
    ];
    expect(chamada[2].body).toContain("Agendado!");
    expect(chamada[2].body).toContain("sáb 07/11");

    expect(tabelas.menu_sessoes?.[0]?.estado).toBe("idle");
    expect(tabelas.menu_sessoes?.[0]?.dados).toEqual({});
  });

  it("reserva recusada: frase da casa, nunca 'Agendado!', estado NAO avanca", async () => {
    comVagaEm07DeNovembro();
    mocks.marcarAgendamentoHandler.mockRejectedValue({
      message: "Horário indisponível",
      code: "agenda_horario_indisponivel",
    });
    const { admin, tabelas } = adminFake(mundo({ menu_sessoes: [sessaoNoPassoFinal()] }));
    const r = await getAction("menu_responder")!.execute(
      ctx(admin, payload({ body_preview: "1" })),
      {},
    );

    expect(mocks.sendMessageHandler).toHaveBeenCalledTimes(1);
    const chamada = mocks.sendMessageHandler.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { body: string },
    ];
    expect(chamada[2].body).toBe(
      "Não consegui marcar esse horário — pode já estar ocupado. Escolha outro.",
    );
    expect(chamada[2].body).not.toContain("Agendado!");
    // O TEXTO de falha foi entregue (desfecho do envio é sucesso) e o run carrega
    // a marca da reserva — mas o passo fica onde estava: o cliente escolhe outro.
    expect(r.status).toBe("success");
    expect(r.detail?.reserva).toBe("falhou");
    expect(tabelas.menu_sessoes?.[0]?.estado).toBe("aguardando_horario");
    expect(tabelas.menu_sessoes?.[0]?.dados).toMatchObject({
      servico_event_type_id: "et-corte",
      dia: "2026-11-07",
    });
  });

  it("reserva criada mas envio recusado: estado AVANCA mesmo assim (excecao pinada)", async () => {
    comVagaEm07DeNovembro();
    mocks.sendMessageHandler.mockRejectedValueOnce({
      message: "Janela de 24 horas fechada.",
      code: "janela_fechada",
    });
    const { admin, tabelas } = adminFake(mundo({ menu_sessoes: [sessaoNoPassoFinal()] }));
    const r = await getAction("menu_responder")!.execute(
      ctx(admin, payload({ body_preview: "1" })),
      {},
    );

    expect(mocks.marcarAgendamentoHandler).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("failed");
    // EXCEÇÃO PINADA (ruling): a reserva é o fato que importa. Não avançar
    // deixaria o cliente re-escolher o MESMO slot numa corrida contra a
    // reserva que já existe no banco.
    expect(tabelas.menu_sessoes?.[0]?.estado).toBe("idle");
    expect(tabelas.menu_sessoes?.[0]?.dados).toEqual({});
  });

  it("tecla do horarios_hoje resolvida por ITEM (ordem 4) busca a uniao — e no G4 tambem", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00.000Z"));
    try {
      // Slots de HOJE (10:00Z, fuso UTC simplificado) — o que a consulta mostra.
      mocks.horariosLivresDaOrg.mockResolvedValue({
        ok: true,
        slots: [
          {
            inicio: new Date("2026-11-07T10:00:00.000Z"),
            fim: new Date("2026-11-07T10:30:00.000Z"),
          },
        ],
        fusoDaRegra: "UTC",
        publicouHorarios: true,
        fusoSuposto: false,
        fontesDefasadas: [],
        agendaExternaNuncaLida: false,
        googleCoberturaParcial: false,
      });

      // (a) A consulta mora na ordem 4 (o dono renumerou): a tecla 4 tem de
      // buscar a união dos serviços — era o bug do `n === 1` fixo.
      const renumerado = adminFake(
        mundo({
          menu_sessoes: [sessao("menu")],
          menu_itens: [
            {
              organization_id: ORG,
              ativo: true,
              ordem: 4,
              rotulo: "Horários de hoje",
              tipo: "consulta",
              consulta: "horarios_hoje",
            },
          ],
        }),
      );
      const a = await getAction("menu_responder")!.execute(
        ctx(renumerado.admin, payload({ body_preview: "4" })),
        {},
      );
      expect(a.status).toBe("success");
      // União = uma chamada POR serviço ativo (2 no fixture).
      expect(mocks.horariosLivresDaOrg).toHaveBeenCalledTimes(2);
      const chamada = mocks.sendMessageHandler.mock.calls[0] as unknown as [
        unknown,
        unknown,
        { body: string },
      ];
      expect(chamada[2].body).toContain("10:00");
      expect(chamada[2].body).not.toContain("Não encontrei horários livres para hoje");

      // (b) Sem itens no banco, a tecla fixa 1 do G4 continua buscando (fallback).
      vi.clearAllMocks();
      mocks.horariosLivresDaOrg.mockResolvedValue({
        ok: true,
        slots: [
          {
            inicio: new Date("2026-11-07T10:00:00.000Z"),
            fim: new Date("2026-11-07T10:30:00.000Z"),
          },
        ],
        fusoDaRegra: "UTC",
        publicouHorarios: true,
        fusoSuposto: false,
        fontesDefasadas: [],
        agendaExternaNuncaLida: false,
        googleCoberturaParcial: false,
      });
      const g4 = adminFake(mundo({ menu_sessoes: [sessao("menu")], menu_itens: [] }));
      const b = await getAction("menu_responder")!.execute(
        ctx(g4.admin, payload({ body_preview: "1" })),
        {},
      );
      expect(b.status).toBe("success");
      expect(mocks.horariosLivresDaOrg).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tecla 1 mapeada a item de texto NAO busca a agenda", async () => {
    const { admin } = adminFake(
      mundo({
        menu_sessoes: [sessao("menu")],
        menu_itens: [
          {
            organization_id: ORG,
            ativo: true,
            ordem: 1,
            rotulo: "Cardápio",
            tipo: "texto",
            resposta_texto: "Cortes e escovas, das 9h às 18h.",
            consulta: null,
          },
        ],
      }),
    );
    const r = await getAction("menu_responder")!.execute(
      ctx(admin, payload({ body_preview: "1" })),
      {},
    );
    expect(r.status).toBe("success");
    expect(mocks.horariosLivresDaOrg).not.toHaveBeenCalled();
    const chamada = mocks.sendMessageHandler.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { body: string },
    ];
    expect(chamada[2].body).toBe("Cortes e escovas, das 9h às 18h.");
  });
});
