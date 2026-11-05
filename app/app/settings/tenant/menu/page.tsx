import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

import { MenuConfigClient, type ItemDaApi } from "./_client";

export const dynamic = "force-dynamic";

/**
 * MENU DE TEXTO (SEM IA) — a tela que o cliente monta o cardápio (spec §6.1,
 * plano Task 8).
 *
 * Molde da agenda (`settings/tenant/agenda/page.tsx`): Server Component com
 * `requireAuth`/`resolveActiveOrg`, a leitura pelo client de SESSÃO (RLS de
 * membro + filtro de org) e o componente de cliente receber os dados PRONTOS —
 * sem `apiClient.get` no mount: o que a tela mostra é o que o servidor leu.
 *
 * ─── Por que a FALHA DE LEITURA é prop própria ──────────────────────────────
 * "Lista vazia" e "não consegui ler" são fatos diferentes (a lição medida da
 * Agenda: erro de leitura virando afirmação sobre os dados). Então são DUAS
 * props: `erroConfiguracao` (o `settings.menu`) e `erroItens` — cada bloco
 * diz qual dos dois aconteceu, e nenhum dos dois chuta estado.
 *
 * ─── E por que o `moduloLigado` (Task 2) não é lido AQUI ─────────────────────
 * A porta desta tela no menu já é condicionada ao módulo
 * (`lib/navigation/catalogo.ts`, `modulo: "menu_whatsapp"` — o mesmo
 * `moduloLigado` por baixo), e a rota `PATCH /api/v1/settings/menu` cobra a
 * camada de módulo de novo no ligar (Task 6). Um QUARTO estado de tela não
 * existe no contrato de 3 estados do plano, e a recusa do gate chega pela
 * mensagem da API (`showApiError`) — a tela não inventa estado que a API
 * recusa.
 *
 * O link público da agenda mora em `organizations.slug` (spec B12): só
 * renderiza quando o slug existe; a rota `/a/<slug>` é da Peça B, e aqui o
 * endereço aparece como "em breve".
 */
export default async function MenuConfigPage() {
  const user = await requireAuth();
  // `t` local em vez do hook: componente de SERVIDOR — o idioma vem resolvido
  // em `user.idioma` (a cadeia pessoa → organização → padrão vive em
  // `lib/auth/server.ts`).
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  // `manager` para ESCREVER (as rotas cobram de novo): `viewer` vê a lista e a
  // pré-visualização — é informação de operação; esconder é cortesia, não
  // autorização.
  const podeEditar =
    (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const supabase = await createClient();
  const [{ data: org, error: erroOrg }, { data: itens, error: erroLista }] = await Promise.all([
    supabase.from("organizations").select("settings, slug").eq("id", activeOrg.orgId).maybeSingle(),
    supabase
      .from("menu_itens" as never)
      .select("*")
      .eq("organization_id", activeOrg.orgId)
      .order("ordem", { ascending: true }),
  ]);

  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  const menu = (settings.menu ?? {}) as Record<string, unknown>;
  const slug = typeof org?.slug === "string" && org.slug !== "" ? org.slug : null;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Menu do WhatsApp")}</h1>
        <p className="mt-1 text-sm text-text-muted">
          {t(
            "Um menu de opções em texto que o cliente responde com número — horários, preços, marcação e passagem para a equipe, sem IA no caminho.",
          )}
        </p>
      </header>
      <MenuConfigClient
        concedido={menu.concedido === true}
        enabled={menu.enabled === true}
        slug={slug}
        itens={(itens ?? []) as unknown as ItemDaApi[]}
        podeEditar={podeEditar}
        erroConfiguracao={erroOrg ? erroOrg.message : null}
        erroItens={erroLista ? erroLista.message : null}
      />
    </div>
  );
}
