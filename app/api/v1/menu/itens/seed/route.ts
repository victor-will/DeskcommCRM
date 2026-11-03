import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Os 4 defaults do G4 — texto byte a byte do §6.1 do plano. A ordem do ARRAY
 * é a ordem do INSERT (o teste do plano compara com ela, item a item).
 *
 * Os itens 3 ("Marcar horário") e 0 ("Falar com alguém") são interpretados
 * pela MÁQUINA antes da busca em `menu_itens` (precedência das teclas pinada
 * em `lib/menu/maquina.test.ts`) — o seed grava os 4 assim mesmo, com
 * `ativo`, para a tela listar o menu completo. `resposta_texto`/`consulta`
 * nulos são gravados como `null` explícito (a coluna é nullable; deixar a
 * chave ausente mudaria o formato da linha).
 */
const SEED_G4 = [
  {
    ordem: 1,
    rotulo: "Horários de hoje",
    tipo: "consulta",
    resposta_texto: null,
    consulta: "horarios_hoje",
    ativo: true,
  },
  {
    ordem: 2,
    rotulo: "Preços dos serviços",
    tipo: "consulta",
    resposta_texto: null,
    consulta: "precos",
    ativo: true,
  },
  {
    ordem: 3,
    rotulo: "Marcar horário",
    tipo: "texto",
    resposta_texto: null,
    consulta: null,
    ativo: true,
  },
  {
    ordem: 0,
    rotulo: "Falar com alguém",
    tipo: "texto",
    resposta_texto: "Certo! Sua mensagem já está com a nossa equipe — alguém te responde por aqui.",
    consulta: null,
    ativo: true,
  },
] as const;

/**
 * POST /api/v1/menu/itens/seed — semeia os 4 defaults do G4 se (e só se) a
 * organização da sessão não tem NENHUM item (idempotente: a 2ª chamada é
 * no-op e responde `criados: 0`).
 *
 * Sem corpo externo — o passo 1 da receita (Zod) não tem o que validar; o
 * resto é integral: suporte → papel (manager) → org da sessão → contagem →
 * (se vazio) insert dos 4 com a org da sessão → `audit()` → `ok()`.
 */
export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "menu_itens" });
  if (!authz.ok) return authz.response;

  const orgId = authz.org.orgId;
  const db = await createClient();

  // ── Idempotente: só semeia se a organização está VAZIA ───────────────────
  const { data: atuais, error: erroLeitura } = await db
    .from("menu_itens" as never)
    .select("*")
    .eq("organization_id", orgId);
  if (erroLeitura) {
    return fail("internal_error", "Falha ao ler os itens do menu.", 500, { requestId });
  }
  if ((atuais ?? []).length > 0) return ok({ criados: 0 }, { requestId });

  const { data: criados, error: erroInsert } = await db
    .from("menu_itens" as never)
    .insert(SEED_G4.map((linha) => ({ ...linha, organization_id: orgId })) as never)
    .select();
  if (erroInsert) return fail("internal_error", "Falha ao semear o menu.", 500, { requestId });

  const total = ((criados ?? []) as unknown[]).length;

  void audit({
    action: "menu.itens_seeded",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "menu_itens",
    resourceId: orgId,
    requestId,
    metadata: { criados: total },
  });

  return ok({ criados: total }, { requestId });
}
