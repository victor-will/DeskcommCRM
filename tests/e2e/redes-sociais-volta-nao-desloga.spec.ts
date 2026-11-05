import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

// ── Pré-condição da JORNADA: a aba existe só com a flag ligada (Addon #1) ───
//
// O interruptor `redes_sociais` nasce DESLIGADO (platform_config sem a linha =
// falha fechada), e com ele desligado `?aba=sociais` cai na aba padrão — o
// RedesSociaisClient nunca monta e o aviso de desfecho que esta spec segue
// ("Autorização concluída") não existe. Numa base fresca (o CI semeia do zero)
// a spec então reprovaria por FALTA DE CENÁRIO, não pelo defeito que ela mede.
// É a mesma doutrina das outras specs de fora: quem precisa de estado semeia o
// PRÓPRIO estado — aqui, a flag da instalação, capturada e restaurada.
const envDaSuporte = carregarEnvLocal();
const admin = createClient(
  envDaSuporte.NEXT_PUBLIC_SUPABASE_URL ?? "",
  envDaSuporte.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const CHAVE_DA_FLAG = "MODULO_REDES_SOCIAIS";
let flagOriginal: { existia: boolean; valor: string | null };

test.beforeAll(async () => {
  const { data, error: erroLeitura } = await admin
    .from("platform_config")
    .select("valor")
    .eq("chave", CHAVE_DA_FLAG);
  if (erroLeitura) throw new Error(`ler a flag do módulo: ${erroLeitura.message}`);
  flagOriginal = { existia: (data?.length ?? 0) > 0, valor: data?.[0]?.valor ?? null };

  const { error } = await admin
    .from("platform_config")
    .upsert({ chave: CHAVE_DA_FLAG, valor: "ligado" } as never, { onConflict: "chave" });
  if (error) throw new Error(`ligar a flag do módulo: ${error.message}`);
});

test.afterAll(async () => {
  const { error } = flagOriginal.existia
    ? await admin
        .from("platform_config")
        .upsert({ chave: CHAVE_DA_FLAG, valor: flagOriginal.valor } as never, { onConflict: "chave" })
    : await admin.from("platform_config").delete().eq("chave", CHAVE_DA_FLAG);
  if (error) throw new Error(`restaurar a flag do módulo: ${error.message}`);
});

/**
 * VOLTAR DA AUTORIZAÇÃO DE REDE SOCIAL NÃO DESLOGA — e diz o desfecho (#1579).
 *
 * Mesmo mecanismo de `agenda-google-volta-nao-desloga.spec.ts`: o provedor
 * devolve o navegador numa navegação iniciada FORA do nosso site, e o cookie
 * de sessão `SameSite=Strict` não viaja nela. Se o destino for uma página
 * autenticada, o `proxy.ts` não vê usuário e manda para `/login`.
 *
 * A ponte `/auth/social-return` é pública e inerte: responde 200 e refaz a
 * navegação a partir do nosso próprio origin, e aí o cookie viaja. A spec segue
 * o DESFECHO — onde a pessoa parou e o que a tela disse —, não o header.
 *
 * O site "de fora" sobe em `127.0.0.1` enquanto o app roda em `localhost`: para
 * o navegador são sites diferentes (porta não conta para SameSite; host conta).
 * Porta 0: o sistema escolhe uma livre, sem colidir com outra spec.
 */
function subirSiteDeFora(destino: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const servidor = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><body>
        <a id="voltar" href="${destino}">voltar</a>
        <script>document.getElementById("voltar").click()</script>
      </body>`);
    });
    servidor.listen(0, "127.0.0.1", () => resolve(servidor));
  });
}

test("voltar da autorização de rede social não manda para o /login e mostra o desfecho", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await loginComoAdmin(page, lerCreds());

  // Controle positivo: logado ANTES do salto. Sem ele, um /login no fim poderia
  // significar "nunca esteve logado" em vez de "perdeu no salto".
  await page.goto("/app/connections?aba=sociais");
  await expect(page, "não cheguei logado em Conexões — o cenário não está montado").toHaveURL(
    /\/app\/connections/,
    { timeout: 20_000 },
  );

  const base = (baseURL ?? "http://localhost:3001").replace(/\/$/, "");
  const destino = `${base}/auth/social-return?connected=facebook&connect_token=SEGREDO`;
  const servidor = await subirSiteDeFora(destino);
  const porta = (servidor.address() as AddressInfo).port;

  try {
    await page.goto(`http://127.0.0.1:${porta}/`);
    await page.waitForURL(/\/(app\/connections|login)/, { timeout: 30_000 });

    const url = page.url();
    expect(
      url,
      `depois de voltar de um site externo, a pessoa parou em ${url}. Ela ESTAVA logada ` +
        "(o controle acima provou): o cookie SameSite=Strict não viajou no salto iniciado de fora.",
    ).not.toContain("/login");
    expect(url).toContain("/app/connections");
    expect(url).toContain("aba=sociais");
    expect(url, "a ponte refletiu o connect_token na URL").not.toContain("SEGREDO");

    // O regex era `/Autorização concluída/` e o Addon #1 acrescentou o SEGUINDE
    // banner ao lado do original ("…! Agora ative o recebimento…") — dois
    // elementos, strict mode. O conserto é no LOCATOR e nunca no produto (doutrina
    // dos locators): ancora no texto do banner ORIGINAL que esta spec media.
    await expect(page.getByText(/Autorização concluída\. Confira/)).toBeVisible({ timeout: 20_000 });
  } finally {
    await new Promise<void>((r) => servidor.close(() => r()));
  }
});
