import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import type { Recurso } from "@/lib/menu/recursos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  recurso: z.enum(["menu_whatsapp", "agenda_online"]),
  concedido: z.boolean(),
});

/** Onde cada recurso mora em `settings` — só a chave do recurso muda. */
const CHAVE_DO_RECURSO = {
  menu_whatsapp: "menu",
  agenda_online: "agenda_online",
} as const satisfies Record<Recurso, string>;

/**
 * PATCH /api/v1/admin/recursos-org/[id] — a camada (b) da ativação em 3
 * camadas: quem ADMINISTRA A INSTÂNCIA concede o recurso à organização
 * (`settings.menu.concedido` / `settings.agenda_online.concedido`).
 *
 * Receita da casa: `requireSupportWrite()` PRIMEIRO (a guarda de EFEITO do
 * acompanhamento — barra escrita vinda de `support_readonly`, molde das rotas
 * admin vizinhas em `admin/cobranca/regua/route.ts`; não substitui as camadas
 * de baixo), depois `requirePlatformAdminEscrita` (escrita de admin exige
 * `scope === 'full'` + MFA em dia — a cerca de
 * `tests/unit/admin-escrita-exige-scope-full.test.ts`), Zod em TUDO (id da rota
 * e corpo), org do PATH (fonte confiável), leitura+escrita com filtro de org
 * programático no admin client, merge RASO dentro da chave do recurso (molde
 * `settings/proposals/route.ts`: o resto do `settings` sobrevive), `audit()` e
 * `ok()`/`fail()`.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    // Quem não é admin de plataforma é REDIRENCIONADO pelo guard; a rota
    // responde a recusa nomeada (mfa_required/forbidden_scope) ou403 comum.
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const parsedId = z
    .string()
    .uuid()
    .safeParse((await params).id);
  if (!parsedId.success)
    return fail("validation_failed", "Identificador inválido.", 422, { requestId });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Campos inválidos.", 422, { requestId });

  const orgId = parsedId.data;
  const admin = createAdminClient();

  const { data: orgRow, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .single();
  if (erroLeitura)
    return fail("internal_error", "Falha ao ler as configurações.", 500, { requestId });
  if (!orgRow) return fail("not_found", "Organização não encontrada.", 404, { requestId });

  const settings = (orgRow.settings ?? {}) as Record<string, unknown>;
  const chave = CHAVE_DO_RECURSO[parsed.data.recurso];
  const blocoAtual = (settings[chave] ?? {}) as Record<string, unknown>;
  // Merge RASO: só a chave do recurso muda de `concedido` — o resto do bloco
  // e o resto do `settings` são preservados byte a byte.
  //
  // ── REVOGAÇÃO desliga junto (achado da revisão) ──────────────────────────
  // Escrever SÓ `concedido:false` deixava `enabled:true` + regra ativa: o menu
  // seguia respondendo cada mensagem com a tela já dizendo "Aguardando
  // ativação". A demote (`enabled:false`) entra no MESMO merge, e a regra de
  // `rule_id` é desativada em seguida com o MESMO filtro de org do desligar da
  // Task 6 — a ordem (settings primeiro) é proposital: com a camada
  // `sem_concessao` da ação, um settings revogado já mata o menu mesmo que a
  // regra persista ativa (fail-closed na direção certa); o inverso deixaria a
  // tela ligada com o menu mudo.
  const revogando = parsed.data.concedido === false;
  const blocoNovo: Record<string, unknown> = revogando
    ? { ...blocoAtual, concedido: false, enabled: false }
    : { ...blocoAtual, concedido: parsed.data.concedido };
  const settingsMesclado = {
    ...settings,
    [chave]: blocoNovo,
  };

  const { error: erroGravacao } = await admin
    .from("organizations")
    .update({ settings: settingsMesclado })
    .eq("id", orgId);
  if (erroGravacao) return fail("internal_error", "Falha ao salvar.", 500, { requestId });

  if (revogando) {
    const ruleId = blocoNovo.rule_id;
    if (typeof ruleId === "string") {
      const { error: erroRegra } = await admin
        .from("automation_rules")
        .update({ is_active: false })
        .eq("id", ruleId)
        .eq("organization_id", orgId)
        .select("id");
      // Escrita parcial documentada: settings já revogado (o menu já parou);
      // um erro aqui é 500 honesto, e re-rule_id obsoleto (0 linhas) é
      // tolerado — a mesma régua do desligar da Task 6.
      if (erroRegra)
        return fail("internal_error", "Falha ao desligar a regra do menu.", 500, {
          requestId,
        });
    }
  }

  void audit({
    action: "recursos_org.concedido_alterado",
    actorUserId: adminCtx.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: { recurso: parsed.data.recurso, concedido: parsed.data.concedido },
  });

  return ok({ recurso: parsed.data.recurso, concedido: parsed.data.concedido }, { requestId });
}
