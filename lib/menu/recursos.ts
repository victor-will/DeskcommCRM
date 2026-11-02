import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Os recursos que a instância concede por PLANO — a coluna
 * `cobranca_planos.recursos` (migration 9079, Task 1) e os dois nomes que
 * aparecem nela. O mesmo vocabulário do `settings.<recurso>.concedido` da
 * camada (b): a chave do recurso no settings é o slug.
 */
export type Recurso = "menu_whatsapp" | "agenda_online";

/**
 * A camada (c) da ativação em 3 camadas: o PLANO do revendedor concede.
 *
 * A régua inteira, na ordem em que as perguntas se respondem:
 *
 *  1. SEM linha em `cobranca_assinaturas` → `true` (isenta). A própria tabela
 *     é quem diz quem é cliente da cobrança da instalação — sem linha, não há
 *     plano a perguntar, e inventar cobrança onde não há é a falha oposta
 *     (travar o menu de quem nunca assinou nada);
 *  2. COM linha → lê `cobranca_planos.recursos` (Task 1) e testa a inclusão do
 *     recurso pedido. Assinatura apontando para plano que não está mais no
 *     catálogo → `false`: sem ler o plano não se concede nada;
 *  3. QUALQUER erro de leitura (das DUAS consultas) → `false` (fail-closed —
 *     a dúvida cala o menu, nunca o contrário).
 *
 * Sem filtro de `estado` da assinatura aqui de propósito: o contrato do ruling
 * é inclusão no plano da linha que existe; se a régua de negócio passar a
 * depender de `ativa/trial`, é nela que isso se escreve.
 */
export async function planoIncluiRecurso(
  admin: SupabaseClient,
  orgId: string,
  r: Recurso,
): Promise<boolean> {
  const { data: assinatura, error: erroAssinatura } = await admin
    .from("cobranca_assinaturas")
    .select("plano_id")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (erroAssinatura) return false;
  if (assinatura === null) return true; // isenta

  const planoId = (assinatura as { plano_id?: string | null }).plano_id;
  if (typeof planoId !== "string" || planoId === "") return false;

  const { data: plano, error: erroPlano } = await admin
    .from("cobranca_planos")
    .select("recursos")
    .eq("id", planoId)
    .maybeSingle();
  if (erroPlano) return false;
  if (plano === null) return false;

  const recursos = (plano as { recursos?: string[] | null }).recursos;
  return Array.isArray(recursos) && recursos.includes(r);
}
