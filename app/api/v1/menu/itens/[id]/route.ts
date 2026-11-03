import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { baseItem, type ItemDoMenu } from "../route";

export const dynamic = "force-dynamic";

/** O mesmo esquema do POST, parcial: só o que vier é atualizado. */
const patchSchema = baseItem.partial();

/**
 * O id do PATH é o id do ITEM — nunca uma organização: a org vem da SESSÃO
 * (nunca do body) e acompanha TODA leitura/escrita como `.eq`, então um id de
 * outra organização responde 404 (não 403 — não se revela que a linha existe).
 * Só o formato é checado aqui.
 */
const idSchema = z.string().min(1).max(100);

/**
 * PATCH /api/v1/menu/itens/[id] — atualiza um item da organização da sessão.
 *
 * Receita da casa: Zod (path + corpo) → suporte → papel (manager) → LEITURA
 * primeiro com o filtro da org (outra org = 404) → consistência sobre o
 * objeto MESCLADO (linha + patch) → escrita com `.eq` de org → `audit()` →
 * `ok()`.
 *
 * `updated_at` é carimbado aqui porque a tabela não tem trigger de touch —
 * sem isto a tela não distinguiria uma edição de uma não-edição.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "menu_itens" });
  if (!authz.ok) return authz.response;

  const parsedId = idSchema.safeParse((await params).id);
  if (!parsedId.success) {
    return fail("validation_failed", "Identificador inválido.", 422, { requestId });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Campos inválidos.", 422, { requestId });

  const orgId = authz.org.orgId;
  const db = await createClient();

  // ── Ler PRIMEIRO, com o filtro da org: outra org = 404 ───────────────────
  const { data: existentes, error: erroLeitura } = await db
    .from("menu_itens" as never)
    .select("*")
    .eq("organization_id", orgId)
    .eq("id", parsedId.data);
  if (erroLeitura) {
    return fail("internal_error", "Falha ao ler o item do menu.", 500, { requestId });
  }
  const atual = ((existentes ?? []) as unknown as ItemDoMenu[])[0];
  if (!atual) return fail("not_found", "Item do menu não encontrado.", 404, { requestId });

  // ── Consistência sobre o objeto MESCLADO (linha + patch) ─────────────────
  // Só o que o patch muda entra na conta: um PATCH que não toca `tipo` não
  // pode recusar a linha por um `consulta` nulo legado, e um patch que VIRA
  // `consulta` sem informar `consulta` é 422 (mesma régua do POST).
  const mesclado = { ...atual, ...parsed.data };
  if (mesclado.tipo === "consulta" && !mesclado.consulta) {
    return fail("validation_failed", "Item de consulta precisa de uma consulta válida.", 422, {
      requestId,
    });
  }

  const { data: atualizados, error: erroUpdate } = await db
    .from("menu_itens" as never)
    .update({ ...parsed.data, updated_at: new Date() } as never)
    .eq("organization_id", orgId)
    .eq("id", parsedId.data)
    .select();
  if (erroUpdate) {
    // `unique (organization_id, ordem)`: a ordem pedida já é de outro item.
    if (erroUpdate.code === "23505") {
      return fail("ordem_ocupada", "Já existe um item com esta ordem no menu.", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Falha ao salvar o item do menu.", 500, { requestId });
  }
  const item = ((atualizados ?? []) as unknown as ItemDoMenu[])[0];
  if (!item) return fail("internal_error", "Falha ao salvar o item do menu.", 500, { requestId });

  void audit({
    action: "menu.item_updated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "menu_itens",
    resourceId: item.id,
    requestId,
    metadata: { ordem: item.ordem, tipo: item.tipo },
  });

  return ok(item, { requestId });
}

/**
 * DELETE /api/v1/menu/itens/[id] — remove um item da organização da sessão.
 *
 * A leitura não é separada: o `.delete()` já é filtrado por `id` + org, e o
 * `.select()` devolve a linha removida — 0 linhas = não é desta org (ou não
 * existe) → 404, mesma resposta dos dois casos (não se revela a vizinha).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "menu_itens" });
  if (!authz.ok) return authz.response;

  const parsedId = idSchema.safeParse((await params).id);
  if (!parsedId.success) {
    return fail("validation_failed", "Identificador inválido.", 422, { requestId });
  }

  const orgId = authz.org.orgId;
  const db = await createClient();

  const { data: removidos, error: erroDelete } = await db
    .from("menu_itens" as never)
    .delete()
    .eq("organization_id", orgId)
    .eq("id", parsedId.data)
    .select();
  if (erroDelete) {
    return fail("internal_error", "Falha ao remover o item do menu.", 500, { requestId });
  }
  const item = ((removidos ?? []) as unknown as ItemDoMenu[])[0];
  if (!item) return fail("not_found", "Item do menu não encontrado.", 404, { requestId });

  void audit({
    action: "menu.item_deleted",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "menu_itens",
    resourceId: item.id,
    requestId,
    metadata: { ordem: item.ordem },
  });

  return ok({ id: item.id }, { requestId });
}
