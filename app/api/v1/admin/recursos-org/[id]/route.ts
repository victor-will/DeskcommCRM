import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
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
 * Receita da casa: `requirePlatformAdminEscrita` (escrita de admin exige
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
  const settingsMesclado = {
    ...settings,
    [chave]: { ...blocoAtual, concedido: parsed.data.concedido },
  };

  const { error: erroGravacao } = await admin
    .from("organizations")
    .update({ settings: settingsMesclado })
    .eq("id", orgId);
  if (erroGravacao) return fail("internal_error", "Falha ao salvar.", 500, { requestId });

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
