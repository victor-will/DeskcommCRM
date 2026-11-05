/**
 * A TELA DE CONFIGURAÇÃO DO MENU — os três estados do plano, a lista e o aviso.
 *
 * Os três casos são o contrato da Task 8, na ordem em que o plano os escreve:
 *
 *   1. "Menu desligado" com a chave (Switch) — o estado normal de quem tem a
 *      concessão e ainda não ligou;
 *   2. SEM concessão → "Aguardando ativação pela administração" + aviso + Switch
 *      DESABILITADO (a tela não oferece um interruptor que a API recusaria);
 *   3. Com itens → a lista renderiza (é ela que a pré-visualização espelha).
 *
 * Mais um quarto caso, o terceiro estado do plano ("Ligado") — a tela promete
 * TRÊS estados, e um estado sem teste é um estado que a próxima refatoração
 * muda em silêncio.
 *
 * O componente de cliente recebe tudo do Server Component (o molde da agenda):
 * aqui não há `apiClient.get` no mount, então o teste renderiza a PÁGINA com o
 * banco falso e as asserções de texto provam o que o servidor entregou junto.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireAuthMock, resolveActiveOrgMock, createClientMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActiveOrgMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
// O `redirect` vive no MESMO módulo do `useRouter` que o cliente usa: o mock
// tem de exportar os dois, senão a página falha no import.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  redirect: vi.fn(),
}));

// O Radix Switch exige polyfills que o jsdom não tem (molde de
// `proposals/_client.test.tsx`).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import MenuPage from "./page";

const ORG_ID = "22222222-2222-4222-8222-222222222222";

type Linha = Record<string, unknown>;

function item(overrides: Partial<Linha> & Linha): Linha {
  return {
    id: "11111111-1111-4111-8111-000000000001",
    organization_id: ORG_ID,
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

/**
 * O mundo da página: `organizations` (settings + slug, `maybeSingle`) e
 * `menu_itens` (select → eq → order, thenable) — os DOIS recortes que a página
 * consulta com o client de sessão.
 */
function montarMundo(
  opts: {
    settings?: Record<string, unknown>;
    slug?: string | null;
    itens?: Linha[];
    erroItens?: string;
  } = {},
) {
  vi.mocked(requireAuthMock).mockResolvedValue({
    idioma: "pt-BR",
    is_platform_admin: false,
    support: false,
  });
  vi.mocked(resolveActiveOrgMock).mockResolvedValue({ orgId: ORG_ID, role: "manager" });

  const settings = opts.settings ?? {};
  const slug = opts.slug ?? null;
  const itens = opts.itens ?? [];
  const erro = opts.erroItens ? { message: opts.erroItens } : null;

  const client = {
    from: (tabela: string) => {
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { settings, slug }, error: null }),
            }),
          }),
        };
      }
      if (tabela === "menu_itens") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                then: (
                  ok: (r: { data: Linha[]; error: unknown }) => unknown,
                  ra?: (e: unknown) => unknown,
                ) => Promise.resolve({ data: itens, error: erro }).then(ok, ra),
              }),
            }),
          }),
        };
      }
      throw new Error(`tabela não mockada: ${tabela}`);
    },
  };
  vi.mocked(createClientMock).mockResolvedValue(client as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("Página de configuração do menu — os três estados do plano", () => {
  it('mostra o estado "desligado" com o Switch', async () => {
    montarMundo({ settings: { menu: { concedido: true, enabled: false } }, slug: null });

    render(await MenuPage());

    expect(screen.getByText("Menu desligado")).toBeInTheDocument();
    const chave = screen.getByRole("switch");
    // Desligado = `aria-checked` falso; e com concessão a chave responde.
    expect(chave).not.toBeChecked();
    expect(chave).not.toBeDisabled();
    // Com concessão, o aviso de espera não aparece.
    expect(screen.queryByTestId("aviso-sem-concessao")).toBeNull();
  });

  it("sem concessão: aviso de espera e Switch desabilitado", async () => {
    montarMundo({ settings: {}, slug: null });

    render(await MenuPage());

    expect(screen.getByText("Aguardando ativação pela administração")).toBeInTheDocument();
    expect(screen.getByTestId("aviso-sem-concessao")).toBeInTheDocument();
    // A tela não oferece um interruptor que a API recusaria: desabilitado.
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("com concessão e ligado: o terceiro estado", async () => {
    montarMundo({ settings: { menu: { concedido: true, enabled: true } } });

    render(await MenuPage());

    expect(screen.getByText("Ligado")).toBeInTheDocument();
    expect(screen.getByRole("switch")).not.toBeDisabled();
  });

  it("com itens: renderiza a lista", async () => {
    montarMundo({
      settings: { menu: { concedido: true, enabled: false } },
      itens: [
        item({ id: "id-a1", ordem: 1, rotulo: "Horários de hoje" }),
        item({ id: "id-a2", ordem: 2, rotulo: "Preços dos serviços", consulta: "precos" }),
      ],
    });

    render(await MenuPage());

    const lista = screen.getByTestId("lista-de-itens");
    const linhas = within(lista).getAllByRole("listitem");
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toHaveTextContent("Horários de hoje");
    expect(linhas[1]).toHaveTextContent("Preços dos serviços");
  });
});

describe("abrirNovo nunca escolhe tecla reservada da máquina", () => {
  // Achado da revisão: com lista vazia o `max+1` dava 0 — tecla 0 é DA
  // MÁQUINA ("Falar com alguém", precedência pinada em lib/menu/maquina.ts):
  // o primeiro item do locatário nascia invisível sob a tecla da máquina.
  it("lista vazia começa em 1 (0 é reservada)", async () => {
    const { proximaOrdemLivre } = await import("./_client");
    expect(proximaOrdemLivre([])).toBe(1);
  });

  it("pula 3 quando max+1 cair nela, e nunca devolve 0 nem 3", async () => {
    const { proximaOrdemLivre, TECLAS_RESERVADAS } = await import("./_client");
    expect(TECLAS_RESERVADAS).toEqual(expect.arrayContaining([0, 3]));
    expect(proximaOrdemLivre([{ ordem: 1 }])).toBe(2);
    expect(proximaOrdemLivre([{ ordem: 1 }, { ordem: 2 }])).toBe(4); // 3 reservada
    expect(proximaOrdemLivre([{ ordem: 3 }])).toBe(4);
    expect(proximaOrdemLivre([{ ordem: 0 }])).toBe(1);
    expect(proximaOrdemLivre([{ ordem: 0 }, { ordem: 3 }])).toBe(4);
    expect(proximaOrdemLivre([{ ordem: 4 }])).toBe(5);

    // Propriedade: para qualquer lista, a escolha nunca é uma tecla da máquina.
    const listas: Array<Array<{ ordem: number }>> = [
      [],
      [{ ordem: 0 }],
      [{ ordem: 1 }],
      [{ ordem: 1 }, { ordem: 2 }],
      [{ ordem: 3 }],
      [{ ordem: 0 }, { ordem: 1 }, { ordem: 2 }, { ordem: 3 }],
      [{ ordem: 7 }],
    ];
    for (const lista of listas) {
      const escolhida = proximaOrdemLivre(lista);
      expect(TECLAS_RESERVADAS, `lista ${JSON.stringify(lista)} → ${escolhida}`).not.toContain(
        escolhida,
      );
    }
  });
});
