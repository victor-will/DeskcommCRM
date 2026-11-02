import type { SupabaseClient } from "@supabase/supabase-js";

import { describe, expect, it } from "vitest";

import { planoIncluiRecurso } from "./recursos";

/**
 * A camada (c) da ativação em 3 camadas: o PLANO do revendedor concede o
 * recurso (Task 1 — `cobranca_planos.recursos`).
 *
 * A régua inteira em uma frase: SEM assinatura a org é ISENTA (a própria
 * tabela `cobranca_assinaturas` é quem diz quem é cliente da cobrança — não
 * inventar cobrança onde não há); COM assinatura o recurso tem de estar no
 * plano; e QUALQUER erro de leitura vira `false` (fail-closed: a dúvida cala
 * o menu, nunca o contrário).
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const PLANO = "33333333-3333-4333-8333-333333333333";

type Linha = Record<string, unknown>;

/**
 * O recorte do PostgREST que `planoIncluiRecurso` usa: select/eq/maybeSingle
 * nas duas tabelas, com injeção de erro por tabela para a ponta fail-closed.
 */
function adminFake(
  tabelas: Record<string, Linha[]>,
  comErroEm: readonly string[] = [],
): { admin: SupabaseClient; consultadas: Set<string> } {
  const consultadas = new Set<string>();

  function builder(tabela: string) {
    consultadas.add(tabela);
    const eqs: Array<[string, unknown]> = [];
    const linhas = () => (tabelas[tabela] ?? []).filter((l) => eqs.every(([c, v]) => l[c] === v));
    const erro = comErroEm.includes(tabela) ? { message: "leitura recusada", code: "XX000" } : null;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => {
        eqs.push([c, v]);
        return q;
      },
      maybeSingle: async () =>
        erro !== null ? { data: null, error: erro } : { data: linhas()[0] ?? null, error: null },
    };
    return q;
  }

  return { admin: { from: builder } as unknown as SupabaseClient, consultadas };
}

describe("planoIncluiRecurso — a camada (c): o plano concede", () => {
  it("org sem assinatura: true (isenta)", async () => {
    const { admin, consultadas } = adminFake({ cobranca_assinaturas: [], cobranca_planos: [] });
    expect(await planoIncluiRecurso(admin, ORG, "menu_whatsapp")).toBe(true);
    // Sem assinatura não há plano a perguntar: nem a leitura do plano acontece.
    expect(consultadas.has("cobranca_planos")).toBe(false);
    // E vale para QUALQUER recurso da união — a isenção não conhece o nome.
    expect(await planoIncluiRecurso(admin, ORG, "agenda_online")).toBe(true);
  });

  it("assinatura com plano cujo recursos inclui menu_whatsapp: true", async () => {
    const { admin } = adminFake({
      cobranca_assinaturas: [{ organization_id: ORG, plano_id: PLANO }],
      cobranca_planos: [{ id: PLANO, recursos: ["menu_whatsapp", "agenda_online"] }],
    });
    expect(await planoIncluiRecurso(admin, ORG, "menu_whatsapp")).toBe(true);
  });

  it("plano sem o recurso: false", async () => {
    const { admin } = adminFake({
      cobranca_assinaturas: [{ organization_id: ORG, plano_id: PLANO }],
      cobranca_planos: [{ id: PLANO, recursos: ["agenda_online"] }],
    });
    expect(await planoIncluiRecurso(admin, ORG, "menu_whatsapp")).toBe(false);

    // E a assinatura apontando para plano que NÃO ESTÁ no catálogo (linha
    // apagada/estranha) também é false: sem ler o plano não se concede nada.
    const { admin: orfao } = adminFake({
      cobranca_assinaturas: [{ organization_id: ORG, plano_id: PLANO }],
      cobranca_planos: [],
    });
    expect(await planoIncluiRecurso(orfao, ORG, "menu_whatsapp")).toBe(false);
  });

  it("erro de leitura: false (fail-closed)", async () => {
    // Erro lendo a assinatura…
    const { admin: semLeitura } = adminFake({ cobranca_assinaturas: [], cobranca_planos: [] }, [
      "cobranca_assinaturas",
    ]);
    expect(await planoIncluiRecurso(semLeitura, ORG, "menu_whatsapp")).toBe(false);

    // …e erro lendo o plano (assinatura legível, plano não).
    const { admin: planoQuebrado } = adminFake(
      {
        cobranca_assinaturas: [{ organization_id: ORG, plano_id: PLANO }],
        cobranca_planos: [{ id: PLANO, recursos: ["menu_whatsapp"] }],
      },
      ["cobranca_planos"],
    );
    expect(await planoIncluiRecurso(planoQuebrado, ORG, "menu_whatsapp")).toBe(false);
  });
});
