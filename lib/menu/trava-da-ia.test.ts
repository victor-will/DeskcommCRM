import type { SupabaseClient } from "@supabase/supabase-js";

import { describe, expect, it } from "vitest";

import { bloqueioHumano, iaResponderiaASessao } from "./trava-da-ia";

/**
 * Trava de convivência IA × menu (R1–R4) — as duas funções que a ação
 * `menu_responder` (Task 5) chama ANTES de responder.
 *
 * Os casos com nome vêm do brief (8, verbatim); os quatro extras pinam exigências
 * do próprio brief/ruling que não têm caso nomeado: a FALHA FECHADA (erro de
 * leitura → `true` nos dois lados — decisão travada do controller) e o passo 3
 * do espelho (`silêncio vigente → true` em `iaResponderiaASessao`, o que dá
 * uso real aos parâmetros `conversationId`/`agora` da assinatura).
 *
 * O client é falso no recorte do PostgREST que as funções usam
 * (select/eq/is/not/limit/maybeSingle — molde dos testes de `lib/automation`),
 * com caminho pontilhado resolvido no objeto embutido (`ai_agent_versions.status`)
 * e injeção de erro por tabela para a falha fechada.
 */

const ORG = "ffffffff-0000-4000-8000-0000000000a1";
// Ids de sessão OPACOS (só comparados entre si). Sem nome de provider: a
// doutrina `restricao-de-canal` e o gate `lint:channels` não distinguem
// comentário de código, e o nome do transportante só pode viver em lib/channels/.
const SESSAO = "sessao-canal-1";
const SESSAO_OUTRA = "sessao-canal-outra";
const CONVERSA = "ffffffff-3333-4000-8000-000000000001";

/** Relógio fixo — determinismo é regra da casa; `agora` é parâmetro, nunca `new Date()`. */
const AGORA = new Date("2026-11-02T12:00:00.000Z");
const SILENCIO_VIGENTE = "2026-11-02T13:00:00.000Z";
const SILENCIO_VENCIDO = "2026-11-02T11:00:00.000Z";

type Linha = Record<string, unknown>;

/** O agente publicado na sessão, no formato que o select embutido devolve. */
function agentePublicado(overrides: Partial<Linha> = {}): Linha {
  return {
    id: "ag-1",
    organization_id: ORG,
    archived_at: null,
    paused_at: null,
    ai_agent_versions: { status: "published", channel_session_id: SESSAO },
    ...overrides,
  };
}

function credencialValidada(overrides: Partial<Linha> = {}): Linha {
  return {
    id: "cred-1",
    organization_id: ORG,
    is_active: true,
    validated_at: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

/** O roteador ativo na sessão, no formato da tabela. */
function roteadorAtivo(overrides: Partial<Linha> = {}): Linha {
  return {
    id: "rot-1",
    organization_id: ORG,
    is_active: true,
    channel_session_id: SESSAO,
    fallback_agent_id: null,
    ...overrides,
  };
}

/**
 * Client falso no recorte do PostgREST que `trava-da-ia` usa: `eq` compara por
 * caminho pontilhado (o embutido `ai_agent_versions.status` vira o objeto
 * aninhado da fixture), `is(col, null)` e `not(col, "is", null)` filtram nulos,
 * `limit` corta, `maybeSingle` devolve a primeira linha ou `null`, e
 * `comErroEm` devolve `{ error }` naquela tabela — é o que simula a falha de
 * leitura da regra fail-closed.
 */
function bancoFalso(
  tabelas: Record<string, Linha[]>,
  opcoes: { comErroEm?: readonly string[] } = {},
): SupabaseClient {
  const erroDe = (tabela: string): { message: string } | null =>
    opcoes.comErroEm?.includes(tabela) === true ? { message: "leitura recusada" } : null;

  function consulta(tabela: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const nulos: string[] = [];
    const naoNulos: string[] = [];
    let limite: number | null = null;

    const valor = (linha: Linha, coluna: string): unknown =>
      coluna
        .split(".")
        .reduce<unknown>(
          (atual, parte) =>
            atual !== null && typeof atual === "object" ? (atual as Linha)[parte] : undefined,
          linha,
        );

    const linhas = (): Linha[] => {
      const fora = (tabelas[tabela] ?? []).filter(
        (l) =>
          eqs.every(([c, v]) => valor(l, c) === v) &&
          ins.every(([c, vs]) => vs.includes(valor(l, c))) &&
          nulos.every((c) => valor(l, c) === null || valor(l, c) === undefined) &&
          naoNulos.every((c) => valor(l, c) !== null && valor(l, c) !== undefined),
      );
      return limite === null ? fora : fora.slice(0, limite);
    };

    const q = {
      select: () => q,
      eq: (coluna: string, v: unknown) => {
        eqs.push([coluna, v]);
        return q;
      },
      in: (coluna: string, valores: unknown[]) => {
        ins.push([coluna, valores]);
        return q;
      },
      is: (coluna: string, v: unknown) => {
        if (v === null) nulos.push(coluna);
        return q;
      },
      not: (coluna: string, operador: string, v: unknown) => {
        if (operador === "is" && v === null) naoNulos.push(coluna);
        return q;
      },
      limit: (n: number) => {
        limite = n;
        return q;
      },
      maybeSingle: async () => {
        const erro = erroDe(tabela);
        if (erro !== null) return { data: null, error: erro };
        return { data: linhas()[0] ?? null, error: null };
      },
      // Consulta de LINHAS VÁRIAS (ai_routers, ai_router_members): o await vem
      // direto do builder, como no client real.
      then: (
        ok: (r: { data: Linha[] | null; error: { message: string } | null }) => unknown,
        ra?: (e: unknown) => unknown,
      ) => {
        const erro = erroDe(tabela);
        const resposta =
          erro !== null
            ? { data: null as Linha[] | null, error: erro }
            : { data: linhas(), error: null };
        return Promise.resolve(resposta).then(ok, ra);
      },
    };
    return q;
  }

  return { from: consulta } as unknown as SupabaseClient;
}

describe("iaResponderiaASessao — espelho do portão do dreno, em Supabase client", () => {
  it("sem agente publicado na sessao: iaResponderia devolve false (menu assume)", async () => {
    // Agente existe, mas a versão está rascunho — o predicado exige published.
    const rascunho = bancoFalso({
      ai_agents: [
        agentePublicado({ ai_agent_versions: { status: "draft", channel_session_id: SESSAO } }),
      ],
      ai_provider_credentials: [credencialValidada()],
    });
    expect(await iaResponderiaASessao(rascunho, ORG, SESSAO, null, AGORA)).toBe(false);

    // Publicada, mas em OUTRA sessão — o número da conversa é o predicado.
    const outraSessao = bancoFalso({
      ai_agents: [
        agentePublicado({
          ai_agent_versions: { status: "published", channel_session_id: SESSAO_OUTRA },
        }),
      ],
      ai_provider_credentials: [credencialValidada()],
    });
    expect(await iaResponderiaASessao(outraSessao, ORG, SESSAO, null, AGORA)).toBe(false);

    // Nada de agente nenhum: também false (o menu assume).
    expect(await iaResponderiaASessao(bancoFalso({}), ORG, SESSAO, null, AGORA)).toBe(false);
  });

  it("agente publicado mas credencial inativa: devolve false (Review Focus 1)", async () => {
    // O Review Focus 1: agente publicado E SEM chave válida — a IA falharia
    // (`ai_gateway_key_missing`) e ninguém responderia; o menu TEM de assumir.
    const db = bancoFalso({
      ai_agents: [agentePublicado()],
      ai_provider_credentials: [credencialValidada({ is_active: false })],
    });
    expect(await iaResponderiaASessao(db, ORG, SESSAO, null, AGORA)).toBe(false);
  });

  it("agente publicado e credencial validada: devolve true (menu sai)", async () => {
    const db = bancoFalso({
      ai_agents: [agentePublicado()],
      ai_provider_credentials: [credencialValidada()],
    });
    expect(await iaResponderiaASessao(db, ORG, SESSAO, null, AGORA)).toBe(true);
  });

  it("credencial sem validated_at: devolve false", async () => {
    // O predicado do gateway-binding é OS DOIS: `is_active AND validated_at
    // is not null`. Ativa mas nunca validada = sem chave que funcione.
    const db = bancoFalso({
      ai_agents: [agentePublicado()],
      ai_provider_credentials: [credencialValidada({ validated_at: null })],
    });
    expect(await iaResponderiaASessao(db, ORG, SESSAO, null, AGORA)).toBe(false);
  });

  it("silencio vigente: iaResponderiaASessao devolve true (o silencio cala os dois)", async () => {
    // Passo 3 do espelho do brief: silêncio vigente → true — o silêncio do
    // humano cala a IA E o menu, e é por isto que a assinatura tem
    // conversationId/agora. Medido nos dois sentidos: com silêncio, TRUE mesmo
    // sem agente nenhum; com silêncio vencido, o portão responde por si.
    const comSilencio = bancoFalso({
      conversations: [{ id: CONVERSA, organization_id: ORG, bot_silenced_until: SILENCIO_VIGENTE }],
    });
    expect(await iaResponderiaASessao(comSilencio, ORG, SESSAO, CONVERSA, AGORA)).toBe(true);

    const silencioVencido = bancoFalso({
      conversations: [{ id: CONVERSA, organization_id: ORG, bot_silenced_until: SILENCIO_VENCIDO }],
    });
    expect(await iaResponderiaASessao(silencioVencido, ORG, SESSAO, CONVERSA, AGORA)).toBe(false);
  });
});

describe("bloqueioHumano — o menu cala onde humano ou régua já responderiam", () => {
  it("silencio vigente: bloqueioHumano true mesmo com estado de menu ativo (Review Focus 4)", async () => {
    // "Silêncio > estado": a sessão pode estar em aguardando_servico à vontade —
    // bot_silenced_until vigente cala o menu. Contato limpo de propósito: o
    // único sinal aqui é o da conversa.
    const db = bancoFalso({
      conversations: [
        {
          id: CONVERSA,
          organization_id: ORG,
          bot_silenced_until: SILENCIO_VIGENTE,
          assignee_kind: null,
        },
      ],
    });
    expect(
      await bloqueioHumano(
        db,
        ORG,
        CONVERSA,
        { force_human: false, ai_opt_out: false, is_blocked: false, is_personal: false },
        AGORA,
      ),
    ).toBe(true);
  });

  it("force_human ou ai_opt_out ou is_blocked: bloqueioHumano true", async () => {
    for (const flags of [
      { force_human: true },
      { ai_opt_out: true },
      { is_blocked: true },
      // O contrato da assinatura também nomeia `is_personal` ("…/pessoal"):
      // contato pessoal não é cliente de menu.
      { is_personal: true },
    ]) {
      expect(
        await bloqueioHumano(bancoFalso({}), ORG, null, flags, AGORA),
        JSON.stringify(flags),
      ).toBe(true);
    }
  });

  it("conversa atribuida a usuario: bloqueioHumano true", async () => {
    // Humano assumiu (assignee_kind = 'user'): quem responde é a pessoa, não
    // o menu — mesmo com silêncio vencido e contato limpo.
    const db = bancoFalso({
      conversations: [
        {
          id: CONVERSA,
          organization_id: ORG,
          bot_silenced_until: SILENCIO_VENCIDO,
          assignee_kind: "user",
        },
      ],
    });
    expect(await bloqueioHumano(db, ORG, CONVERSA, null, AGORA)).toBe(true);
  });

  it("nada de bloqueio: devolve false", async () => {
    const db = bancoFalso({
      conversations: [
        {
          id: CONVERSA,
          organization_id: ORG,
          bot_silenced_until: SILENCIO_VENCIDO,
          assignee_kind: null,
        },
      ],
    });
    expect(
      await bloqueioHumano(
        db,
        ORG,
        CONVERSA,
        { force_human: false, ai_opt_out: false, is_blocked: false, is_personal: false },
        AGORA,
      ),
    ).toBe(false);

    // Sem conversa ainda (id nulo) e sem contato: nada de sinal, o menu fala.
    expect(await bloqueioHumano(bancoFalso({}), ORG, null, null, AGORA)).toBe(false);
  });
});

describe("falha fechada — erro de leitura cala o menu (ruling do controller)", () => {
  it("erro ao ler a conversa: bloqueioHumano devolve true", async () => {
    const db = bancoFalso(
      {
        conversations: [
          { id: CONVERSA, organization_id: ORG, bot_silenced_until: null, assignee_kind: null },
        ],
      },
      { comErroEm: ["conversations"] },
    );
    // Nem o contato limpo adianta: a leitura quebrou, e "menu assume por não
    // saber" é exatamente o que a decisão travada proíbe.
    expect(
      await bloqueioHumano(db, ORG, CONVERSA, { force_human: false, ai_opt_out: false }, AGORA),
    ).toBe(true);
  });

  it("erro ao ler agente ou credencial: iaResponderiaASessao devolve true", async () => {
    const semAgente = bancoFalso({}, { comErroEm: ["ai_agents"] });
    expect(await iaResponderiaASessao(semAgente, ORG, SESSAO, null, AGORA)).toBe(true);

    const semCredencial = bancoFalso(
      { ai_agents: [agentePublicado()] },
      { comErroEm: ["ai_provider_credentials"] },
    );
    expect(await iaResponderiaASessao(semCredencial, ORG, SESSAO, null, AGORA)).toBe(true);
  });

  it("erro ao ler o silencio: iaResponderiaASessao devolve true", async () => {
    const db = bancoFalso({ ai_agents: [agentePublicado()] }, { comErroEm: ["conversations"] });
    expect(await iaResponderiaASessao(db, ORG, SESSAO, CONVERSA, AGORA)).toBe(true);
  });
});

/**
 * O roteador — o outro lado do `OR` do portão pg
 * (`quem-atende-a-sessao.ts:55-96`): uma sessão cuja única atenção é um
 * roteador ativo (fallback/membros com versão publicada — SEM predicado de
 * sessão sobre eles, igual ao SQL) recebe resposta da IA, e o menu tem de sair
 * de perto. Sem este ramo, a Task 5 responderia toda mensagem junto com o
 * dreno — a resposta dupla que o R1 existe para impedir.
 */
describe("espelho do roteador — iaResponderiaASessao cobre o OR do portão", () => {
  it("router ativo na sessao sem agente direto: iaResponderia devolve true (espelho do roteador)", async () => {
    // Fallback publicado em OUTRA sessão: o direto não o acha (predicado de
    // sessão), o roteador sim (SEM predicado de sessão — mesmo SQL de origem).
    const comFallback = bancoFalso({
      ai_routers: [roteadorAtivo({ fallback_agent_id: "ag-fb" })],
      ai_router_members: [],
      ai_agents: [
        {
          id: "ag-fb",
          organization_id: ORG,
          archived_at: null,
          paused_at: null,
          ai_agent_versions: { status: "published", channel_session_id: SESSAO_OUTRA },
        },
      ],
      ai_provider_credentials: [credencialValidada()],
    });
    expect(await iaResponderiaASessao(comFallback, ORG, SESSAO, null, AGORA)).toBe(true);

    // E o outro ramo do OR: router SEM fallback, com membro publicado (também
    // em outra sessão) — a mesma verdade do SQL.
    const comMembro = bancoFalso({
      ai_routers: [roteadorAtivo()],
      ai_router_members: [
        { id: "mem-1", router_id: "rot-1", organization_id: ORG, agent_id: "ag-mb" },
      ],
      ai_agents: [
        {
          id: "ag-mb",
          organization_id: ORG,
          archived_at: null,
          paused_at: null,
          ai_agent_versions: { status: "published", channel_session_id: SESSAO_OUTRA },
        },
      ],
      ai_provider_credentials: [credencialValidada()],
    });
    expect(await iaResponderiaASessao(comMembro, ORG, SESSAO, null, AGORA)).toBe(true);
  });

  it("router sem agente vivo com versao publicada: iaResponderia devolve false", async () => {
    // O predicado do portão é vivo + publicado: fallback ARQUIVADO e membro em
    // versão RASCUNHO não abrem o portão — o menu assume.
    const mortos = bancoFalso({
      ai_routers: [roteadorAtivo({ fallback_agent_id: "ag-morto" })],
      ai_router_members: [
        { id: "mem-1", router_id: "rot-1", organization_id: ORG, agent_id: "ag-rascunho" },
      ],
      ai_agents: [
        {
          id: "ag-morto",
          organization_id: ORG,
          archived_at: "2026-09-01T00:00:00.000Z",
          paused_at: null,
          ai_agent_versions: { status: "published", channel_session_id: SESSAO },
        },
        {
          id: "ag-rascunho",
          organization_id: ORG,
          archived_at: null,
          paused_at: null,
          ai_agent_versions: { status: "draft", channel_session_id: SESSAO },
        },
      ],
      ai_provider_credentials: [credencialValidada()],
    });
    expect(await iaResponderiaASessao(mortos, ORG, SESSAO, null, AGORA)).toBe(false);

    // Router ativo sem fallback e sem membros: nada de quem responda.
    const vazio = bancoFalso({
      ai_routers: [roteadorAtivo()],
      ai_router_members: [],
      ai_agents: [],
      ai_provider_credentials: [credencialValidada()],
    });
    expect(await iaResponderiaASessao(vazio, ORG, SESSAO, null, AGORA)).toBe(false);
  });

  it("erro ao ler o roteador: iaResponderiaASessao devolve true (falha fechada)", async () => {
    const semRoteadores = bancoFalso(
      { ai_agents: [], ai_provider_credentials: [credencialValidada()] },
      { comErroEm: ["ai_routers"] },
    );
    expect(await iaResponderiaASessao(semRoteadores, ORG, SESSAO, null, AGORA)).toBe(true);

    const semMembros = bancoFalso(
      {
        ai_routers: [roteadorAtivo({ fallback_agent_id: "ag-fb" })],
        ai_agents: [],
        ai_provider_credentials: [credencialValidada()],
      },
      { comErroEm: ["ai_router_members"] },
    );
    expect(await iaResponderiaASessao(semMembros, ORG, SESSAO, null, AGORA)).toBe(true);
  });
});
