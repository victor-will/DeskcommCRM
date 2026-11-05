import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { semearMenuSeVazio } from "@/lib/menu/seed";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/menu/itens/seed — semeia os 4 defaults do G4 se (e só se) a
 * organização da sessão não tem NENHUM item (idempotente: a 2ª chamada é
 * no-op e responde `criados: 0`).
 *
 * Os dados e a régua vivem em `lib/menu/seed.ts` (fonte única com o seed do
 * LIGAR — revisão final); esta rota é a PORTA MANUAL do mesmo seed.
 *
 * Sem corpo externo — o passo 1 da receita (Zod) não tem o que validar; o
 * resto é integral: suporte → papel (manager) → org da sessão → semear →
 * `audit()` → `ok()`.
 */
export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "menu_itens" });
  if (!authz.ok) return authz.response;

  const orgId = authz.org.orgId;
  const db = await createClient();

  const { criados, erro } = await semearMenuSeVazio(db, orgId);
  if (erro !== null) {
    return fail("internal_error", "Falha ao semear o menu.", 500, { requestId });
  }
  if (criados === 0) return ok({ criados: 0 }, { requestId });

  void audit({
    action: "menu.itens_seeded",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "menu_itens",
    resourceId: orgId,
    requestId,
    metadata: { criados },
  });

  return ok({ criados }, { requestId });
}
