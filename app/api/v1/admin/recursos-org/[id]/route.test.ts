import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EscritaDePlatformAdminNegada,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/requirePlatformAdmin", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdminEscrita: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

/**
 * A camada (b): quem ADMINISTRA A INSTÂNCIA concede o recurso à organização —
 * `settings.<recurso>.concedido` com merge RASO (molde de
 * `settings/proposals/route.ts`: o resto do `settings` sobrevive).
 */
function montarMundo(stored: Record<string, unknown>) {
  vi.mocked(requirePlatformAdminEscrita).mockResolvedValue({
    user: { id: USER_ID },
    platformAdmin: { user_id: USER_ID, scope: "full", mfa_required: true },
  } as never);

  let gravado: Record<string, unknown> | null = null;
  const client = {
    from: (tabela: string) => {
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
    expect(mundo.gravado?.agenda_online).toEqual({ concedido: false });
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
});
