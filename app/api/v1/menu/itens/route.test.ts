import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"; // a ORGANIZAÇÃO DA SESSÃO
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"; // a vizinha (nunca deve ser alcançável)
const USER_ID = "11111111-1111-4111-8111-111111111111";

type Linha = Record<string, unknown>;

/** O recorte do PostgREST que as três rotas usam sobre `menu_itens`. */
function montarMundo(itensIniciais: Linha[] = []) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_A },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);

  const store: Linha[] = [...itensIniciais];
  let proximoId = 1;

  function builder() {
    const eqs: Array<[string, unknown]> = [];
    let pendente: { insert?: Linha[]; update?: Linha; remover?: boolean } | null = null;
    const filtrar = () => store.filter((l) => eqs.every(([c, v]) => l[c] === v));

    const q = {
      select: () => q,
      insert: (rows: Linha | Linha[]) => {
        pendente = { insert: Array.isArray(rows) ? rows : [rows] };
        return q;
      },
      update: (patch: Linha) => {
        pendente = { update: patch };
        return q;
      },
      delete: () => {
        pendente = { remover: true };
        return q;
      },
      eq: (c: string, v: unknown) => {
        eqs.push([c, v]);
        return q;
      },
      order: () => q,
      then: (ok: (r: { data: Linha[]; error: null }) => unknown, ra?: (e: unknown) => unknown) => {
        if (pendente?.insert) {
          const novos = pendente.insert.map((r) => {
            // O default da coluna (`ativo`) e o id nascem aqui, como no banco.
            const linha = { id: `id-fake-${proximoId++}`, ativo: true, ...r };
            store.push(linha);
            return { ...linha };
          });
          return Promise.resolve({ data: novos, error: null }).then(ok, ra);
        }
        if (pendente?.update) {
          const alvos = filtrar();
          for (const alvo of alvos) Object.assign(alvo, pendente.update);
          return Promise.resolve({ data: alvos.map((a) => ({ ...a })), error: null }).then(ok, ra);
        }
        if (pendente?.remover) {
          const alvos = filtrar();
          for (const alvo of alvos) store.splice(store.indexOf(alvo), 1);
          return Promise.resolve({ data: alvos.map((a) => ({ ...a })), error: null }).then(ok, ra);
        }
        const linhas = filtrar();
        return Promise.resolve({ data: linhas.map((l) => ({ ...l })), error: null }).then(ok, ra);
      },
    };
    return q;
  }

  vi.mocked(createClient).mockResolvedValue({ from: () => builder() } as never);

  return { store };
}

function item(overrides: Partial<Linha> & Linha): Linha {
  return {
    id: "11111111-1111-4111-8111-000000000001",
    organization_id: ORG_A,
    ordem: 1,
    rotulo: "Horários de hoje",
    tipo: "consulta",
    resposta_texto: null,
    consulta: "horarios_hoje",
    ativo: true,
    created_at: "2026-11-01T12:00:00.000Z",
    updated_at: "2026-11-01T12:00:00.000Z",
    ...overrides,
  };
}

async function GET() {
  const { GET: handler } = await import("./route");
  const res = await handler();
  return { status: res.status, body: (await res.clone().json()) as Record<string, unknown> };
}

async function POST(corpo: unknown) {
  const { POST: handler } = await import("./route");
  const res = await handler(
    new NextRequest("http://localhost/api/v1/menu/itens", {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
  );
  return { status: res.status, body: (await res.clone().json()) as Record<string, unknown> };
}

async function PATCH(id: string, corpo: unknown) {
  const { PATCH: handler } = await import("./[id]/route");
  const res = await handler(
    new NextRequest(`http://localhost/api/v1/menu/itens/${id}`, {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.clone().json()) as Record<string, unknown> };
}

async function DELETE(id: string) {
  const { DELETE: handler } = await import("./[id]/route");
  const res = await handler(
    new NextRequest(`http://localhost/api/v1/menu/itens/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.clone().json()) as Record<string, unknown> };
}

async function seed() {
  const { POST: handler } = await import("./seed/route");
  const res = await handler();
  return { status: res.status, body: (await res.clone().json()) as Record<string, unknown> };
}

/** Os 4 defaults do G4 — o byte exato que o seed tem de gravar (plano Task 7). */
const SEED_ESPERADO: Linha[] = [
  {
    ordem: 1,
    rotulo: "Horários de hoje",
    tipo: "consulta",
    resposta_texto: null,
    consulta: "horarios_hoje",
    ativo: true,
    organization_id: ORG_A,
  },
  {
    ordem: 2,
    rotulo: "Preços dos serviços",
    tipo: "consulta",
    resposta_texto: null,
    consulta: "precos",
    ativo: true,
    organization_id: ORG_A,
  },
  {
    ordem: 3,
    rotulo: "Marcar horário",
    tipo: "texto",
    resposta_texto: null,
    consulta: null,
    ativo: true,
    organization_id: ORG_A,
  },
  {
    ordem: 0,
    rotulo: "Falar com alguém",
    tipo: "texto",
    resposta_texto: "Certo! Sua mensagem já está com a nossa equipe — alguém te responde por aqui.",
    consulta: null,
    ativo: true,
    organization_id: ORG_A,
  },
];

function recorte(l: Linha): Linha {
  const { ordem, rotulo, tipo, resposta_texto, consulta, ativo, organization_id } = l;
  return { ordem, rotulo, tipo, resposta_texto, consulta, ativo, organization_id };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/menu/itens — a lista é da ORGANIZAÇÃO DA SESSÃO", () => {
  it("lista só a organizacao da sessao", async () => {
    const { store } = montarMundo([
      item({ id: "id-a1", organization_id: ORG_A, ordem: 1 }),
      item({ id: "id-b1", organization_id: ORG_B, ordem: 1 }),
      item({ id: "id-a2", organization_id: ORG_A, ordem: 2 }),
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    // Contrato da Task 8 (brief verbatim): `ok({ itens })` — a lista mora em `data.itens`.
    const itens = (res.body.data as { itens: Array<{ id: string; organization_id: string }> })
      .itens;
    expect(itens.map((i) => i.id)).toEqual(["id-a1", "id-a2"]);
    expect(itens.every((i) => i.organization_id === ORG_A)).toBe(true);
    expect(store, "a rota só LÊ — nada sai do store").toHaveLength(3);
  });
});

describe("POST /api/v1/menu/itens — criação", () => {
  it("cria com a organizacao da sessao (201) e audita", async () => {
    const { store } = montarMundo();
    const res = await POST({
      ordem: 1,
      rotulo: "Cardápio",
      tipo: "texto",
      resposta_texto: "Cortes e escovas.",
    });
    expect(res.status).toBe(201);
    const criado = res.body.data as { id: string; organization_id: string; ativo: boolean };
    // A org vem da SESSÃO — o corpo não tem como dizer outra (anti-pattern 10).
    expect(criado.organization_id).toBe(ORG_A);
    expect(criado.id).toBeTruthy();
    expect(criado.ativo).toBe(true); // default da coluna
    expect(store).toHaveLength(1);

    const { audit } = await import("@/lib/audit");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "menu.item_created", resourceId: criado.id }),
    );
  });

  it("máximo de 10 itens por organização: 400 e nada criado", async () => {
    const dez = Array.from({ length: 10 }, (_, i) =>
      item({ id: `id-${i}`, ordem: i, rotulo: `Item ${i}` }),
    );
    const { store } = montarMundo(dez);
    const res = await POST({ ordem: 99, rotulo: "Mais um", tipo: "texto", resposta_texto: "x" });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("limite_de_itens");
    expect(store).toHaveLength(10);
  });

  it("validacao: tipo consulta sem consulta é recusado (422); texto com consulta passa (permissivo)", async () => {
    montarMundo();
    const semConsulta = await POST({ ordem: 1, rotulo: "Agenda", tipo: "consulta" });
    expect(semConsulta.status).toBe(422);
    expect((semConsulta.body as { error: { code: string } }).error.code).toBe("validation_failed");

    // A escolha anotada: o CAMPO `consulta` em item de texto é ignorado pela
    // máquina — aceitar (permissivo) em vez de inventar regra nova.
    const torto = await POST({ ordem: 2, rotulo: "X", tipo: "banana" });
    expect(torto.status).toBe(422);

    const textoComConsulta = await POST({
      ordem: 3,
      rotulo: "Y",
      tipo: "texto",
      resposta_texto: "z",
      consulta: "precos",
    });
    expect(textoComConsulta.status).toBe(201);
  });
});

describe("PATCH/DELETE /api/v1/menu/itens/[id] — o id é da SESSÃO, não do body", () => {
  it("PATCH do proprio item: atualiza e carimba updated_at", async () => {
    const { store } = montarMundo([item({ id: "id-a1", ordem: 1, rotulo: "Antigo" })]);
    const antes = String(store[0]?.updated_at);
    const res = await PATCH("id-a1", { rotulo: "Novo" });
    expect(res.status).toBe(200);
    expect(store[0]?.rotulo).toBe("Novo");
    expect(store[0]?.updated_at).not.toBe(antes);
    const { audit } = await import("@/lib/audit");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "menu.item_updated" }));
  });

  it("PATCH de outra org: 404 e a linha intacta", async () => {
    const { store } = montarMundo([item({ id: "id-b1", organization_id: ORG_B })]);
    const res = await PATCH("id-b1", { rotulo: "Intruso" });
    expect(res.status).toBe(404);
    expect(store[0]?.rotulo).toBe("Horários de hoje");
  });

  it("DELETE do proprio item: sai da lista (200)", async () => {
    const { store } = montarMundo([item({ id: "id-a1" }), item({ id: "id-a2", ordem: 2 })]);
    const res = await DELETE("id-a1");
    expect(res.status).toBe(200);
    expect((res.body.data as { id: string }).id).toBe("id-a1");
    expect(store.map((l) => l.id)).toEqual(["id-a2"]);
    const { audit } = await import("@/lib/audit");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "menu.item_deleted" }));
  });

  it("DELETE de outra org: 404 e a linha continua lá", async () => {
    const { store } = montarMundo([item({ id: "id-b1", organization_id: ORG_B })]);
    const res = await DELETE("id-b1");
    expect(res.status).toBe(404);
    expect(store).toHaveLength(1);
  });
});

describe("POST /api/v1/menu/itens/seed — os 4 defaults do G4", () => {
  it("seed cria exatamente os 4 itens com o conteudo byte-exato", async () => {
    const { store } = montarMundo();
    const res = await seed();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ criados: 4 });
    expect(store).toHaveLength(4);
    // Byte a byte do plano G4 — a tela e a máquina contam com estes textos.
    expect(store.map(recorte)).toEqual(SEED_ESPERADO);
  });

  it("seed é idempotente: a 2ª chamada não duplica", async () => {
    const { store } = montarMundo();
    await seed();
    const segunda = await seed();
    expect(segunda.status).toBe(200);
    expect(segunda.body.data).toEqual({ criados: 0 });
    expect(store).toHaveLength(4);
    // E o conteúdo segue íntegro (a 2ª não reescreve nada).
    expect(store.map(recorte)).toEqual(SEED_ESPERADO);
  });
});
