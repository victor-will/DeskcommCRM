import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { planoIncluiRecurso } from "@/lib/menu/recursos";
import { semearMenuSeVazio } from "@/lib/menu/seed";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ enabled: z.boolean() });

/** O nome da regra — único por organização pelo `rule_id` em `settings.menu`. */
const NOME_DA_REGRA = "Menu do WhatsApp";

type MenuSalvo = {
  enabled?: boolean;
  concedido?: boolean;
  rule_id?: string;
  [chave: string]: unknown;
};

/**
 * PATCH /api/v1/settings/menu — o toggle do cliente (camada (c) da ativação
 * em 3 camadas; spec §6.1, plano Task 6).
 *
 * Receita da casa, nesta ordem: suporte → papel (manager) → Zod → leitura →
 * (só no `true`) as TRÊS camadas do gate → ciclo de vida da regra → merge raso
 * de `settings` → `audit()` → `ok()`/`fail()`.
 *
 * O gate de `enabled=true` é o ruling do controller, e as três precisam dizer
 * sim: módulo instalado (`moduloLigado`), concedido pela administração
 * (`settings.menu.concedido`) e plano que concede o recurso
 * (`planoIncluiRecurso`). Qualquer "não" é 403 — o menu não liga sozinho.
 *
 * O `admin client` para TUDO (molde de `settings/proposals/route.ts`, issue
 * #144): o manager comum casaria 0 linhas no UPDATE de `organizations` pela
 * RLS, e o erro de papel real é o `requireRole` de cima.
 *
 * Ciclo de vida da regra (nunca duplicar): ligar ADOTA uma regra órfã/legada
 * de (org, gatilho, nome) — é ela que fecha os dois buracos de duplicação do
 * review (INSERT órfão e corrida entre duas chamadas) —, ou CRIA, ou REATIVA a
 * linha de `settings.menu.rule_id`; se a gravação de settings falhar depois de
 * um INSERT novo, a recém-criada é DESATIVADA (compensação) e o erro volta.
 * Desligar marca `is_active=false` e mantém a linha; religar reutiliza a mesma.
 * `conditions: []` — medido na Task 5 Step 1a: o superRefine do schema aceita
 * lista vazia para `message.received`.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "organizations" });
  if (!authz.ok) return authz.response;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Campos inválidos.", 422, { requestId });

  const orgId = authz.org.orgId;
  const admin = createAdminClient();

  const { data: orgRow, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .single();
  if (erroLeitura || !orgRow) {
    return fail("internal_error", "Falha ao ler as configurações.", 500, { requestId });
  }
  const settings = (orgRow.settings ?? {}) as Record<string, unknown>;
  const menuAtual = (settings.menu ?? {}) as MenuSalvo;

  const { enabled } = parsed.data;
  if (enabled) {
    // ── As TRÊS camadas do gate, nesta ordem (ruling do controller) ─────────
    if (!(await moduloLigado(admin, "menu_whatsapp"))) {
      return fail("forbidden", "O módulo do menu não está instalado nesta instalação.", 403, {
        requestId,
      });
    }
    if (menuAtual.concedido !== true) {
      return fail(
        "forbidden",
        "O menu ainda não foi concedido pela administração desta instalação.",
        403,
        { requestId },
      );
    }
    if (!(await planoIncluiRecurso(admin, orgId, "menu_whatsapp"))) {
      return fail("forbidden", "O plano desta organização não inclui o recurso do menu.", 403, {
        requestId,
      });
    }

    // ── Ligar: adota, cria OU reativa — nunca duplica ───────────────────────
    let ruleId = typeof menuAtual.rule_id === "string" ? menuAtual.rule_id : null;
    let criadaNestaChamada = false;
    if (ruleId !== null) {
      const { data: reativadas, error: erroReativar } = await admin
        .from("automation_rules")
        .update({ is_active: true })
        .eq("id", ruleId)
        // Filtro de organização PROGRAMÁTICO em toda escrita (anti-pattern 10).
        .eq("organization_id", orgId)
        .select("id");
      if (erroReativar)
        return fail("internal_error", "Falha ao religar o menu.", 500, { requestId });
      if (!reativadas || reativadas.length === 0) ruleId = null; // a linha sumiu: adota/cria
    }
    if (ruleId === null) {
      // ── ADOÇÃO da regra órfã/legada por (org, gatilho, nome) — fix round 1 ──
      // É ela que fecha os DOIS buracos de duplicação do review: (a) um
      // INSERT anterior ficou ATIVO e a gravação de settings falhou (o retry
      // não acha rule_id); (b) duas chamadas simultâneas leram sem rule_id.
      // Sem adotar antes de inserir, cada retry/limiar inseriria uma SEGUNDA
      // regra ativa e todo `message.received` rodaria o menu DUAS vezes — e
      // `automation_rules` não tem constraint que impeça (só PK + índice
      // parcial NÃO único, baseline.sql:5801-5819).
      const { data: existentes, error: erroBusca } = await admin
        .from("automation_rules")
        .select("id, is_active")
        .eq("organization_id", orgId)
        .eq("trigger_event", "message.received")
        .eq("name", NOME_DA_REGRA)
        .order("created_at", { ascending: true });
      if (erroBusca) {
        return fail("internal_error", "Falha ao procurar a regra do menu.", 500, { requestId });
      }
      const existente = existentes?.[0] ?? null;

      if (existente !== null) {
        ruleId = String((existente as { id: unknown }).id);
        // Adotar é LIGAR: uma existente inativa (desligado que perdeu o
        // rule_id) é ativada aqui, na mesma ida.
        if ((existente as { is_active?: unknown }).is_active !== true) {
          const { error: erroAtivar } = await admin
            .from("automation_rules")
            .update({ is_active: true })
            .eq("id", ruleId)
            .eq("organization_id", orgId)
            .select("id");
          if (erroAtivar) {
            return fail("internal_error", "Falha ao religar o menu.", 500, { requestId });
          }
        }
      } else {
        const { data: criada, error: erroCriar } = await admin
          .from("automation_rules")
          .insert({
            organization_id: orgId,
            name: NOME_DA_REGRA,
            trigger_event: "message.received",
            conditions: [],
            actions: [{ type: "menu_responder", config: {} }],
            is_active: true,
          })
          .select("id")
          .single();
        if (erroCriar || !criada) {
          return fail("internal_error", "Falha ao criar a regra do menu.", 500, { requestId });
        }
        ruleId = String((criada as { id: unknown }).id);
        criadaNestaChamada = true;
      }
    }

    const menuNovo: MenuSalvo = { ...menuAtual, enabled: true, rule_id: ruleId };
    const settingsMesclado = { ...settings, menu: menuNovo };
    const { error: erroGravacao } = await admin
      .from("organizations")
      .update({ settings: settingsMesclado })
      .eq("id", orgId);
    if (erroGravacao) {
      // ── COMPENSAÇÃO — fix round 1 ─────────────────────────────────────────
      // A regra nasceu AGORA e a gravação de settings FALHOU: sem este passo o
      // estado fica "regra ativa sem rule_id" — o retry (que não acha o id)
      // inseriria OUTRA ativa e todo `message.received` rodaria o menu DUAS
      // vezes. Desativa a recém-criada e devolve o erro: o estado consistente
      // é "menu desligado". A compensação é best-effort (o erro principal já
      // vai para o operador; a trilha está no run).
      if (criadaNestaChamada && ruleId !== null) {
        await admin
          .from("automation_rules")
          .update({ is_active: false })
          .eq("id", ruleId)
          .eq("organization_id", orgId);
      }
      return fail("internal_error", "Falha ao salvar.", 500, { requestId });
    }

    // ── Seed dos 4 defaults do G4 — melhor esforço, FAIL-OPEN (ruling) ──────
    // O POST /seed não tinha chamador de produção: a org nova ficava sem o
    // cardápio até alguém chamar a rota à mão. O primeiro LIGAR semeia (a
    // mesma régua idempotente de `lib/menu/seed.ts`). Se o insert falhar, o
    // toggle NÃO falha: sem itens a máquina responde pelo cardápio fixo G4 e a
    // tela mostra a lista vazia — o `logger.warn` deixa o rastro para quem
    // investigar.
    const seed = await semearMenuSeVazio(admin, orgId);
    if (seed.erro !== null) {
      logger.warn("menu: seed dos defaults do G4 nao gravou (fail-open)", {
        organization_id: orgId,
        erro: seed.erro,
      });
    }

    void audit({
      action: "settings.menu_updated",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "organization",
      resourceId: orgId,
      requestId,
      metadata: { enabled },
    });
    return ok({ enabled }, { requestId });
  }

  // ── Desligar: a regra fica (is_active=false) e religar reutiliza ──────────
  const ruleId = typeof menuAtual.rule_id === "string" ? menuAtual.rule_id : null;
  if (ruleId !== null) {
    const { error: erroDesligar } = await admin
      .from("automation_rules")
      .update({ is_active: false })
      .eq("id", ruleId)
      .eq("organization_id", orgId)
      .select("id");
    if (erroDesligar)
      return fail("internal_error", "Falha ao desligar o menu.", 500, { requestId });
    // Linha ausente (rule_id obsoleto) é tolerada: desligar a TELA não pode
    // ficar refém de uma regra que alguém apagou.
  }

  const settingsMesclado = { ...settings, menu: { ...menuAtual, enabled: false } };
  const { error: erroGravacao } = await admin
    .from("organizations")
    .update({ settings: settingsMesclado })
    .eq("id", orgId);
  if (erroGravacao) return fail("internal_error", "Falha ao salvar.", 500, { requestId });

  void audit({
    action: "settings.menu_updated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: { enabled },
  });
  return ok({ enabled }, { requestId });
}
