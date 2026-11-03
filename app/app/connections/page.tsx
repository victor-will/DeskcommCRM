import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ConexoesShell } from "@/components/connections/ConexoesShell";
import { canalGraphParceiroLigado, GRAPH_PARTNER_LABEL } from "@/lib/channels/graph-parceiro/credentials";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Conexões" };

export default async function ConnectionsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const idioma = user.idioma;

  const key = process.env.WAHA_API_KEY;
  const wahaConfigured = Boolean(
    process.env.WAHA_API_BASE_URL && key && key !== "dev_plaintext_change_me",
  );
  const wacallsConfigured = Boolean(process.env.WACALLS_API_BASE_URL);

  // ─── A descoberta é decidida AQUI, no servidor (Addon #1, gap 2) ─────────
  // `platform_config` não tem policy (0341): só o service role a lê (cabeçalho
  // de `lib/instalacao/modulos.ts`) — o client de sessão leria 0 linhas e a
  // aba nunca apareceria, falhando fechado em silêncio. Mesmo mecanismo do
  // `graphParceiro` logo abaixo, só que assíncrono.
  const redesSociais = await moduloLigado(createAdminClient(), "redes_sociais");

  // A copy nova entra na MESMA frase — e só quando a flag liga: com ela
  // desligada o header é byte-idêntico ao de hoje (contrato do brief).
  const descricaoBase = traduzir(
    "Por onde seu negócio fala com o cliente. Conecte números por QR ou o número oficial da Meta, e acompanhe a saúde de cada um.",
    idioma,
  );
  const descricao = redesSociais
    ? `${descricaoBase} ${traduzir(
        "Conecte também seu Instagram e seu Messenger — as mensagens chegam na mesma caixa de entrada.",
        idioma,
      )}`
    : descricaoBase;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Conexões", idioma)}</h1>
        <p className="text-sm text-muted-foreground">{descricao}</p>
      </header>
      <ConexoesShell
        wahaConfigured={wahaConfigured}
        wacallsConfigured={wacallsConfigured}
        graphParceiro={canalGraphParceiroLigado() ? { label: GRAPH_PARTNER_LABEL } : null}
        redesSociais={redesSociais}
      />
    </div>
  );
}
