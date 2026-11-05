import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import {
  EscritaDePlatformAdminNegada,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/requirePlatformAdmin", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdminEscrita: vi.fn(),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

type Linha = Record<string, unknown>;

/**
 * A camada (b): quem ADMINISTRA A INSTÂNCIA concede o recurso à organização —
 * `settings.<recurso>.concedido` com merge RASO (molde de
 * `settings/proposals/route.ts`: o resto do `settings` sobrevive).
 *
 * `regras` entra para a REVOGAÇÃO (achado da revisão final): quando
 * `concedido:false` é escrito, a rota desliga `enabled` E apaga a regra de
 * `rule_id` — a contagem precisa ficar visível daqui.
 */
function montarMundo(stored: Record<string, unknown>, opts: { regras?: Linha[] } = {}) {
  vi.mocked(requirePlatformAdminEscrita).mockResolvedValue({
    user: { id: USER_ID },
    platformAdmin: { user_id: USER_ID, scope: "full", mfa_required: true },
  } as never);

  const regras: Linha[] = [...(opts.regras ?? [])];
  let gravado: Record<string, unknown> | null = null;
  const client = {
    from: (tabela: string) => {
      if (tabela === "automation_rules") {
        // Cadeia da rota: `.update(patch).eq(id).eq(org).select()`.
        return {
          update: (patch: Linha) => {
            const eqs: Array<[string, unknown]> = [];
            const q = {
              eq: (c: string, v: unknown) => {
                eqs.push([c, v]);
                return q;
              },
              select: () => q,
              then: (
                ok: (r: { data: Linha[]; error: null }) => unknown,
                ra?: (e: unknown) => unknown,
              ) => {
                const alvos = regras.filter((l) => eqs.every(([c, v]) => l[c] === v));
                for (const alvo of alvos) Object.assign(alvo, patch);
                return Promise.resolve({
                  data: alvos.map((a) => ({ id: a.id })),
                  error: null,
                }).then(ok, ra);
              },
            };
            return q;
          },
        };
      }
      if (tabela !== "organizations") throw new Error(`tabela não mockada: ${tabela}`);
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { settings: stored }, error: null }),
          }),
        }),
        update: (patch: { settings: Record<string, unknown> }) => ({
          eq: async () => {
            gravado = patch.settings;
            return { error: null };
          },
        }),
      };
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);

  return {
    get gravado() {
      return gravado;
    },
    regras,
    async PATCH(corpo: unknown) {
      const { PATCH } = await import("./route");
      const res = await PATCH(
        new NextRequest(`http://localhost/api/v1/admin/recursos-org/${ORG_ID}`, {
          method: "PATCH",
          body: JSON.stringify(corpo),
          headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ id: ORG_ID }) },
      );
      return { status: res.status, body: (await res.clone().json()) as Record<string, unknown> };
    },
  };
}

describe("PATCH /api/v1/admin/recursos-org/[id] — a camada (b): concessão da instância", () => {
  beforeEach(() => {
    vi.mocked(requirePlatformAdminEscrita).mockReset();
  });

  it("concede menu_whatsapp com merge raso: o resto do settings sobrevive", async () => {
    const mundo = montarMundo({
      menu: { enabled: false },
      agenda_online: { concedido: false, outra_chave: "x" },
      routing: { qualquer: 1 },
    });
    const res = await mundo.PATCH({ recurso: "menu_whatsapp", concedido: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ recurso: "menu_whatsapp", concedido: true });

    expect(mundo.gravado?.menu).toEqual({ enabled: false, concedido: true });
    // Só a chave do recurso muda: agenda_online e o resto do settings intactos.
    expect(mundo.gravado?.agenda_online).toEqual({ concedido: false, outra_chave: "x" });
    expect(mundo.gravado?.routing).toEqual({ qualquer: 1 });

    const { audit } = await import("@/lib/audit");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "recursos_org.concedido_alterado",
        metadata: { recurso: "menu_whatsapp", concedido: true },
      }),
    );
  });

  it("concede agenda_online na chave dele", async () => {
    const mundo = montarMundo({ menu: { concedido: true } });
    const res = await mundo.PATCH({ recurso: "agenda_online", concedido: false });
    expect(res.status).toBe(200);
    // A revogação carrega a demote junto (ruling da revisão): `enabled:false`
    // no MESMO merge — e o bloco do MENU, de outra chave, fica intocado.
    expect(mundo.gravado?.agenda_online).toEqual({ concedido: false, enabled: false });
    expect(mundo.gravado?.menu).toEqual({ concedido: true });
  });

  it("corpo inválido: 422 e nada gravado", async () => {
    const mundo = montarMundo({ menu: {} });
    const res = await mundo.PATCH({ recurso: "banana", concedido: true });
    expect(res.status).toBe(422);
    expect((res.body as { error: { code: string } }).error.code).toBe("validation_failed");
    expect(mundo.gravado).toBeNull();
  });

  it("escrita de platform admin negada (scope/mfa): 403 e nada gravado", async () => {
    const mundo = montarMundo({ menu: {} });
    // Depois do montarMundo (ele re-seta o mock com resolução bem-sucedida).
    vi.mocked(requirePlatformAdminEscrita).mockRejectedValue(
      new EscritaDePlatformAdminNegada("forbidden_scope"),
    );
    const res = await mundo.PATCH({ recurso: "menu_whatsapp", concedido: true });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("forbidden_scope");
    expect(mundo.gravado).toBeNull();
  });

  it("REVOGAR concede:false desliga enabled E apaga a regra (contagem segue 1)", async () => {
    // O achado da revisão: revogar deixava `enabled:true` + regra ativa → o
    // menu continuava respondendo com a tela dizendo "Aguardando ativação".
    // A demote acontece NO MESMO merge (enabled:false) e a regra é apagada com
    // o MESMO filtro de org que o desligar da Task 6 usa.
    const mundo = montarMundo(
      { menu: { concedido: true, enabled: true, rule_id: "rule-1", mantido: "x" } },
      {
        regras: [
          {
            id: "rule-1",
            organization_id: ORG_ID,
            name: "Menu do WhatsApp",
            trigger_event: "message.received",
            is_active: true,
          },
        ],
      },
    );
    const res = await mundo.PATCH({ recurso: "menu_whatsapp", concedido: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ recurso: "menu_whatsapp", concedido: false });

    // Merge RASO com a demote embutida: o resto do bloco sobrevive.
    expect(mundo.gravado?.menu).toEqual({
      concedido: false,
      enabled: false,
      rule_id: "rule-1",
      mantido: "x",
    });
    // A regra: MESMA linha, contagem 1, is_active=false — nunca some.
    expect(mundo.regras).toHaveLength(1);
    expect(mundo.regras[0]?.is_active).toBe(false);
  });

  it("concedir segue sem demote: enabled gravado é o que já estava", async () => {
    const mundo = montarMundo({ menu: { enabled: true, mantido: "x" } });
    const res = await mundo.PATCH({ recurso: "menu_whatsapp", concedido: true });
    expect(res.status).toBe(200);
    expect(mundo.gravado?.menu).toEqual({ enabled: true, concedido: true, mantido: "x" });
  });

  it("quem não é platform admin (o redirect do guard vira rota): 403 forbidden, nada gravado", async () => {
    // O caso do plano da Task 9 ("non-platform-admin → 403"), distinto do de
    // cima: sem LINHA em `platform_admins` o guard real chama
    // `redirect("/admin/forbidden")` (requirePlatformAdmin.ts:60-62), e em rota
    // `falhaDaEscritaDePlatformAdmin` mapeia QUALQUER erro que não seja
    // `EscritaDePlatformAdminNegada` para 403 `forbidden` — por isso o objeto
    // lançado aqui é um erro COMUM (o NEXT_REDIRECT), não a recusa nomeada.
    const mundo = montarMundo({ menu: {} });
    vi.mocked(requirePlatformAdminEscrita).mockRejectedValue(
      Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;error" }),
    );
    const res = await mundo.PATCH({ recurso: "menu_whatsapp", concedido: true });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("forbidden");
    expect(mundo.gravado).toBeNull();
  });

  it("acompanhamento somente leitura (support_readonly): 403 antes do efeito", async () => {
    // A guarda de EFEITO (`requireSupportWrite`) é a camada de FORA: ela roda
    // antes do platform-admin e antes de tocar o banco — o gate
    // `suporte-cobertura-de-efeitos` cobra a chamada, e este caso prova que a
    // rota a OBEDECE (molde: proposals/[id] passa o `fail` adiante).
    const mundo = montarMundo({ menu: {} });
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(
      fail("forbidden", "Este acompanhamento permite somente leitura.", 403) as never,
    );
    const res = await mundo.PATCH({ recurso: "menu_whatsapp", concedido: true });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("forbidden");
    // Nada gravado, e o guard de platform-admin nem foi consultado.
    expect(mundo.gravado).toBeNull();
    expect(requirePlatformAdminEscrita).not.toHaveBeenCalled();
  });
});
