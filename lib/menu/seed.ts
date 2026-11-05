import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Os 4 defaults do G4 — texto byte a byte do §6.1 do plano (a mesma lista que
 * a rota `/seed` já gravava; extraída para cá na revisão final porque o seed
 * agora TEM chamador de produção: o primeiro LIGAR do menu).
 *
 * A ordem do ARRAY é a ordem do INSERT (1 · 2 · 3 · 0), e os `null`s de
 * `resposta_texto`/`consulta` são explícitos: a coluna é nullable e deixar a
 * chave ausente mudaria o formato da linha.
 *
 * Os itens 3 e 0 são respondidos pela MÁQUINA antes de qualquer item de
 * `menu_itens` (precedência pinada em `lib/menu/maquina.test.ts`); o seed
 * grava os 4 assim mesmo, com `ativo`, para a tela listar completo.
 */
export const SEED_G4 = [
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
 * Semeia os 4 defaults SE (e só se) a organização não tem nenhum item — a
 * mesma régua idempotente da rota `POST /seed` (que continua existindo como
 * porta manual).
 *
 * Devolve `{ criados, erro }` em vez de lançar: quem chama decide se o erro é
 * fatal (a rota `/seed` devolve 500) ou best-effort (o ligar do menu é
 * fail-open — sem itens a máquina responde pelo cardápio fixo, e a tela mostra
 * a lista vazia).
 */
export async function semearMenuSeVazio(
  db: SupabaseClient,
  orgId: string,
): Promise<{ criados: number; erro: string | null }> {
  const { data, error } = await db
    .from("menu_itens" as never)
    .select("*")
    .eq("organization_id", orgId);
  if (error) return { criados: 0, erro: error.message };
  if ((data ?? []).length > 0) return { criados: 0, erro: null };

  const { data: novos, error: erroInsert } = await db
    .from("menu_itens" as never)
    .insert(SEED_G4.map((linha) => ({ ...linha, organization_id: orgId })) as never)
    .select();
  if (erroInsert) return { criados: 0, erro: erroInsert.message };
  return { criados: ((novos ?? []) as unknown[]).length, erro: null };
}
