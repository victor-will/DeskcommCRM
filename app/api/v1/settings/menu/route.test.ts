import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { planoIncluiRecurso } from "@/lib/menu/recursos";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("@/lib/menu/recursos", () => ({ planoIncluiRecurso: vi.fn(async () => true) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

type Linha = Record<string, unknown>;

/**
 * O mundo da rota: `organizations` (leitura+escrita de `settings`, molde de
 * `settings/proposals/route.test.ts`), `automation_rules` (insert com
 * `select().single()` no fim, update com `eq().eq().select()`) e `menu_itens`
 * (o seed do ligar — achado da revisão: o G4 precisa nascer no primeiro ligar).
 */
function montarMundo(
  stored: { settings: Record<string, unknown>; regras: Linha[]; itens?: Linha[] },
  opts: { idDaRegra?: string; erroAoSalvar?: boolean } = { idDaRegra: "rule-novo" },
) {
  const itens: Linha[] = [...(stored.itens ?? [])];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
  vi.mocked(moduloLigado).mockResolvedValue(true);
  vi.mocked(planoIncluiRecurso).mockResolvedValue(true);

  let gravado: Record<string, unknown> | null = null;
  let proximoId = 0;

  function regrasBuilder() {
    let pendente: { patch?: Linha; insert?: Linha } = {};
    const eqs: Array<[string, unknown]> = [];
    const aplicar = () => {
      const alvos = stored.regras.filter((l) => eqs.every(([c, v]) => l[c] === v));
      for (const alvo of alvos) Object.assign(alvo, pendente.patch ?? {});
      return alvos.map((a) => ({ id: a.id }));
    };
    const q = {
      insert: (row: Linha) => {
        pendente = { insert: row };
        return q;
      },
      update: (patch: Linha) => {
        pendente = { patch };
        return q;
      },
      eq: (c: string, v: unknown) => {
        eqs.push([c, v]);
        return q;
      },
      order: () => q,
      select: () => q,
      single: async () => {
        const id = proximoId++ === 0 ? (opts.idDaRegra ?? "rule-novo") : `rule-${proximoId}`;
        stored.regras.push({ id, ...pendente.insert });
        return { data: { id }, error: null };
      },
      then: (ok: (r: { data: unknown; error: null }) => unknown, ra?: (e: unknown) => unknown) =>
        Promise.resolve({ data: aplicar(), error: null }).then(ok, ra),
    };
    return q;
  }

  const client = {
    from: (tabela: string) => {
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { settings: stored.settings }, error: null }),
            }),
          }),
          update: (patch: { settings: Record<string, unknown> }) => ({
            eq: async () => {
              if (opts.erroAoSalvar === true) {
                return { error: { message: "banco indisponível", code: "XX001" } };
              }
              gravado = patch.settings;
              stored.settings = patch.settings;
              return { error: null };
            },
          }),
        };
      }
      if (tabela === "automation_rules") return regrasBuilder();
      if (tabela === "menu_itens") {
        // select().eq() → lista (a contagem do seed); insert().select() → linhas.
        let inserindo: Linha[] | null = null;
        const eqs: Array<[string, unknown]> = [];
        const q = {
          select: () => q,
          eq: (c: string, v: unknown) => {
            eqs.push([c, v]);
            return q;
          },
          insert: (linhas: Linha | Linha[]) => {
            inserindo = Array.isArray(linhas) ? linhas : [linhas];
            return q;
          },
          then: (
            ok: (r: { data: Linha[]; error: null }) => unknown,
            ra?: (e: unknown) => unknown,
          ) => {
            if (inserindo !== null) {
              const novos = inserindo.map((r, i) => ({
                id: `id-semeado-${i + 1}`,
                ativo: true,
                ...r,
              }));
              itens.push(...novos);
              return Promise.resolve({ data: novos.map((n) => ({ ...n })), error: null }).then(
                ok,
                ra,
              );
            }
            const alvos = itens.filter((l) => eqs.every(([c, v]) => l[c] === v));
            return Promise.resolve({ data: alvos.map((a) => ({ ...a })), error: null }).then(
              ok,
              ra,
            );
          },
        };
        return q;
      }
      throw new Error(`tabela não mockada: ${tabela}`);
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);

  return {
    get gravado() {
      return gravado;
    },
    get regras() {
      return stored.regras;
    },
    get itens() {
      return itens;
    },
    async PATCH(corpo: unknown) {
      const { PATCH } = await import("./route");
      const res = await PATCH(
        new NextRequest("http://localhost/api/v1/settings/menu", {
          method: "PATCH",
          body: JSON.stringify(corpo),
          headers: { "content-type": "application/json" },
        }),
      );
      return { status: res.status, body: (await res.clone().json()) as Record<string, unknown> };
    },
  };
}

describe("PATCH /api/v1/settings/menu — as três camadas decidem o `true`", () => {
  beforeEach(() => {
    // Só o HISTÓRICO: `montarMundo` re-estabelece as implementações de todos
    // os mocks em cada caso (molde de proposals), e o que se quer medir aqui é
    // se ESTE caso chamou (ou não) cada camada.
    vi.clearAllMocks();
  });

  it("liga sem concessão: 403, nada gravado e nenhuma regra tocada", async () => {
    const mundo = montarMundo({ settings: { menu: { mantido: "x" } }, regras: [] });
    const res = await mundo.PATCH({ enabled: true });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("forbidden");
    expect(mundo.gravado).toBeNull();
    expect(
      planoIncluiRecurso,
      "a camada do plano só é perguntada depois da concessão",
    ).not.toHaveBeenCalled();

    // As OUTRAS duas camadas do mesmo gate (ruling): módulo não instalado e
    // plano sem o recurso — as três precisam dizer sim, senão403.
    vi.mocked(moduloLigado).mockResolvedValue(false);
    expect((await mundo.PATCH({ enabled: true })).status).toBe(403);
    vi.mocked(moduloLigado).mockResolvedValue(true);

    // …e a camada do plano com o resto de pé: mesmas 403, mesmo nada gravado.
    const mundoComPlano = montarMundo({ settings: { menu: { concedido: true } }, regras: [] });
    vi.mocked(planoIncluiRecurso).mockResolvedValue(false);
    expect((await mundoComPlano.PATCH({ enabled: true })).status).toBe(403);
    expect(mundoComPlano.gravado).toBeNull();
    vi.mocked(planoIncluiRecurso).mockResolvedValue(true);
  });

  it("liga com concessão + plano: regra criada ativa e rule_id gravado", async () => {
    const mundo = montarMundo({
      settings: { menu: { concedido: true, mantido: "x" } },
      regras: [],
    });
    const res = await mundo.PATCH({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ enabled: true });
    expect(moduloLigado).toHaveBeenCalledWith(expect.anything(), "menu_whatsapp");
    expect(planoIncluiRecurso).toHaveBeenCalledWith(expect.anything(), ORG_ID, "menu_whatsapp");

    expect(mundo.regras).toHaveLength(1);
    expect(mundo.regras[0]).toMatchObject({
      organization_id: ORG_ID,
      name: "Menu do WhatsApp",
      trigger_event: "message.received",
      conditions: [],
      actions: [{ type: "menu_responder", config: {} }],
      is_active: true,
    });
    // Merge RASO: o que já estava em `settings.menu` sobrevive.
    expect(mundo.gravado?.menu).toMatchObject({
      concedido: true,
      mantido: "x",
      enabled: true,
      rule_id: "rule-novo",
    });
  });

  it("desliga: a regra fica is_active=false (contagem 1) e o resto do menu preservado", async () => {
    const mundo = montarMundo({
      settings: { menu: { concedido: true, enabled: true, rule_id: "rule-1", mantido: "x" } },
      regras: [
        {
          id: "rule-1",
          organization_id: ORG_ID,
          name: "Menu do WhatsApp",
          trigger_event: "message.received",
          is_active: true,
        },
      ],
    });
    const res = await mundo.PATCH({ enabled: false });
    expect(res.status).toBe(200);
    expect(mundo.regras).toHaveLength(1);
    expect(mundo.regras[0]?.is_active).toBe(false);
    expect(mundo.gravado?.menu).toMatchObject({
      concedido: true,
      enabled: false,
      rule_id: "rule-1",
      mantido: "x",
    });
    // Desligar não pergunta ao plano nem ao módulo: o gate é do `true`.
    expect(planoIncluiRecurso).not.toHaveBeenCalled();
  });

  it("religar: reutiliza a MESMA regra (contagem segue 1)", async () => {
    const mundo = montarMundo({
      settings: { menu: { concedido: true, enabled: false, rule_id: "rule-1" } },
      regras: [
        {
          id: "rule-1",
          organization_id: ORG_ID,
          name: "Menu do WhatsApp",
          trigger_event: "message.received",
          is_active: false,
        },
      ],
    });
    const res = await mundo.PATCH({ enabled: true });
    expect(res.status).toBe(200);
    expect(mundo.regras).toHaveLength(1);
    expect(mundo.regras[0]?.id).toBe("rule-1");
    expect(mundo.regras[0]?.is_active).toBe(true);
    expect(mundo.gravado?.menu).toMatchObject({ enabled: true, rule_id: "rule-1" });
  });

  it("gravacao de settings falha depois do INSERT: erro E a regra recem-criada sai de cena (compensacao)", async () => {
    const mundo = montarMundo(
      { settings: { menu: { concedido: true } }, regras: [] },
      { idDaRegra: "rule-9", erroAoSalvar: true },
    );
    const res = await mundo.PATCH({ enabled: true });
    expect(res.status).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("internal_error");
    expect(mundo.gravado).toBeNull();
    // A COMPENSAÇÃO (fix round 1): a regra nasceu AGORA e a gravação falhou —
    // sem desativá-la, o retry (que não acha rule_id) inseriria OUTRA ativa e
    // todo message.received rodaria o menu DUAS vezes.
    expect(mundo.regras).toHaveLength(1);
    expect(mundo.regras[0]?.is_active).toBe(false);
  });

  it("regra orfa sem rule_id nas settings: ADOTADA — contagem de regras e de ativas segue 1", async () => {
    // O estado que o caso de cima deixa quando o retry chega: regra ATIVA no
    // banco, `settings.menu` sem `rule_id`. Sem adoção, o retry inseriria a
    // segunda — é o buraco (a) do review.
    const mundo = montarMundo({
      settings: { menu: { concedido: true } },
      regras: [
        {
          id: "rule-orfa",
          organization_id: ORG_ID,
          name: "Menu do WhatsApp",
          trigger_event: "message.received",
          is_active: true,
        },
      ],
    });
    const res = await mundo.PATCH({ enabled: true });
    expect(res.status).toBe(200);
    // ADOTOU em vez de inserir: total de regras da org continua 1…
    expect(mundo.regras).toHaveLength(1);
    expect(mundo.regras[0]?.id).toBe("rule-orfa");
    // …o settings registra o id da EXISTENTE…
    expect(mundo.gravado?.menu).toMatchObject({ enabled: true, rule_id: "rule-orfa" });
    // …e as ATIVAS da org seguem 1 (nada de regra duplicada no motor).
    expect(
      mundo.regras.filter((r) => r.is_active === true && r.organization_id === ORG_ID),
    ).toHaveLength(1);

    // A variante INATIVA (desligado que perdeu o rule_id): adota E ativa —
    // ligar é ligar, e a contagem continua 1.
    const inativa = montarMundo({
      settings: { menu: { concedido: true } },
      regras: [
        {
          id: "rule-perdida",
          organization_id: ORG_ID,
          name: "Menu do WhatsApp",
          trigger_event: "message.received",
          is_active: false,
        },
      ],
    });
    const res2 = await inativa.PATCH({ enabled: true });
    expect(res2.status).toBe(200);
    expect(inativa.regras).toHaveLength(1);
    expect(inativa.regras[0]?.is_active).toBe(true);
    expect(inativa.gravado?.menu).toMatchObject({ rule_id: "rule-perdida" });
  });

  it("ligar semeia os 4 defaults do G4 numa org vazia — e a 2ª vez nao duplica", async () => {
    // O achado da revisão: o POST /seed não tinha chamador de produção — os 4
    // defaults do G4 nunca nasciam. O seed agora roda no caminho de SUCESSO do
    // ligar (best-effort), idempotente pela mesma régua do /seed.
    const mundo = montarMundo({ settings: { menu: { concedido: true } }, regras: [], itens: [] });
    const primeira = await mundo.PATCH({ enabled: true });
    expect(primeira.status).toBe(200);
    expect(mundo.itens, "o primeiro ligar deveria criar os 4 defaults").toHaveLength(4);
    // O texto byte a byte do G4 (pinado também pelo teste do /seed).
    expect(mundo.itens[0]).toMatchObject({
      ordem: 1,
      rotulo: "Horários de hoje",
      tipo: "consulta",
      consulta: "horarios_hoje",
      organization_id: ORG_ID,
      ativo: true,
    });
    expect(mundo.itens.map((i) => i.ordem)).toEqual([1, 2, 3, 0]);

    // Idempotente: um SEGUNDO ligar (re-ligar) não duplica nada.
    const segunda = await mundo.PATCH({ enabled: true });
    expect(segunda.status).toBe(200);
    expect(mundo.itens, "o segundo ligar não pode duplicar os defaults").toHaveLength(4);
  });
});
