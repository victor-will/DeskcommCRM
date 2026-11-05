import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Teto de itens por organização (plano Task 7): estourou, 400. */
const MAX_ITENS = 10;

/**
 * O corpo de um item do menu — a ÚNICA fonte da forma: POST usa direto, o
 * PATCH de `[id]` aplica `.partial()` em cima (importa de `../route`) para a
 * regra de validação não driftar entre criar e editar.
 *
 * Consistência: `tipo: "consulta"` SEM `consulta` é recusado (superRefine
 * abaixo; no PATCH a checagem é sobre o objeto MESCLADO com a linha — ver
 * `[id]/route.ts`). O inverso — campo `consulta` preenchido num item `texto`
 * — é PERMISSIVO de propósito: a máquina ignora o campo nesse tipo (a
 * precedência das teclas 3/0 mora em `lib/menu/maquina.ts`, pinada no teste
 * dela) e inventar regra nova seria pior que aceitar. Decisão anotada no
 * plano Task 7.
 */
export const baseItem = z.object({
  ordem: z.number().int().min(0),
  rotulo: z.string().min(1).max(200),
  tipo: z.enum(["texto", "consulta"]),
  resposta_texto: z.string().max(2000).nullish(),
  consulta: z.enum(["horarios_hoje", "precos", "link_agenda"]).nullish(),
});

const postSchema = baseItem.superRefine((item, ctx) => {
  if (item.tipo === "consulta" && !item.consulta) {
    ctx.addIssue({
      code: "custom",
      path: ["consulta"],
      message: "Item de consulta precisa de uma consulta válida.",
    });
  }
});

/**
 * Uma linha de `menu_itens` como a rota a devolve. A tabela é provisionada
 * pelo módulo (ADR-0002 — fora do `baseline.sql`, logo ausente de
 * `lib/database.types.ts`), então as queries usam `.from("menu_itens" as never)`
 * e os resultados são recortados neste tipo.
 */
export type ItemDoMenu = {
  id: string;
  organization_id: string;
  ordem: number;
  rotulo: string;
  tipo: "texto" | "consulta";
  resposta_texto: string | null;
  consulta: string | null;
  ativo: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * GET /api/v1/menu/itens — a lista dos itens da ORGANIZAÇÃO DA SESSÃO
 * (`ok({ itens })` — contrato que a Task 8 consome).
 *
 * Leitura: só o papel (`requireRole`), sem `requireSupportWrite` — não
 * escreve. A org vem da sessão e o filtro `.eq("organization_id", …)` corre
 * na própria query (RLS do client de sessão + filtro explícito): a
 * organização vizinha nunca aparece.
 */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "menu_itens" });
  if (!authz.ok) return authz.response;

  const db = await createClient();
  const { data, error } = await db
    .from("menu_itens" as never)
    .select("*")
    .eq("organization_id", authz.org.orgId)
    .order("ordem", { ascending: true });
  if (error) return fail("internal_error", "Falha ao listar os itens do menu.", 500, { requestId });

  const itens = (data ?? []) as unknown as ItemDoMenu[];
  return ok({ itens }, { requestId });
}

/**
 * POST /api/v1/menu/itens — cria um item na ORGANIZAÇÃO DA SESSÃO (201).
 *
 * Receita da casa, nesta ordem: Zod → suporte (`requireSupportWrite`) → papel
 * (manager) → org SEMPRE da sessão, nunca do body → teto de 10 → insert →
 * `audit()` → `ok()`.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "menu_itens" });
  if (!authz.ok) return authz.response;

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Campos inválidos.", 422, { requestId });

  const orgId = authz.org.orgId;
  const db = await createClient();

  // ── Teto de 10 itens por organização (plano Task 7) ──────────────────────
  // Contagem por select comum (a tabela cabe no teto — não há contagem por
  // head aqui de propósito: o mesmo select devolve as linhas se precisar).
  const { data: atuais, error: erroContagem } = await db
    .from("menu_itens" as never)
    .select("*")
    .eq("organization_id", orgId);
  if (erroContagem) {
    return fail("internal_error", "Falha ao contar os itens do menu.", 500, { requestId });
  }
  if ((atuais ?? []).length >= MAX_ITENS) {
    return fail("limite_de_itens", "O menu já está no máximo de 10 itens.", 400, { requestId });
  }

  const { data: criados, error: erroInsert } = await db
    .from("menu_itens" as never)
    .insert({
      organization_id: orgId,
      ordem: parsed.data.ordem,
      rotulo: parsed.data.rotulo,
      tipo: parsed.data.tipo,
      resposta_texto: parsed.data.resposta_texto ?? null,
      consulta: parsed.data.consulta ?? null,
    } as never)
    .select();
  if (erroInsert) {
    // `unique (organization_id, ordem)`: outra requisição pegou a mesma ordem.
    if (erroInsert.code === "23505") {
      return fail("ordem_ocupada", "Já existe um item com esta ordem no menu.", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Falha ao criar o item do menu.", 500, { requestId });
  }

  const item = ((criados ?? []) as unknown as ItemDoMenu[])[0];
  if (!item) return fail("internal_error", "Falha ao criar o item do menu.", 500, { requestId });

  void audit({
    action: "menu.item_created",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "menu_itens",
    resourceId: item.id,
    requestId,
    metadata: { ordem: item.ordem, tipo: item.tipo },
  });

  return ok(item, { status: 201, requestId });
}
