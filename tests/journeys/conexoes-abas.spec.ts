/**
 * Conexões: um lugar só para conectar canal.
 *
 * O defeito que esta jornada trava: conectar por QR ficava em `/app/connections`,
 * conectar o número OFICIAL ficava em Configurações, e os templates numa terceira
 * tela. O usuário precisava saber de antemão que "conectar meu WhatsApp" tinha
 * resposta diferente dependendo de QUAL WhatsApp — que é conhecimento sobre o nosso
 * código, não sobre o negócio dele.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const EVIDENCE = path.join(process.cwd(), "evidence/canais/conexoes");
fs.mkdirSync(EVIDENCE, { recursive: true });

test("as duas formas de conectar vivem lado a lado, na mesma tela", async ({ page }) => {
  await page.goto("/app/connections");
  await expect(page.getByRole("tab", { name: /Números por QR/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /API Oficial/i })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/01-abas.png`, fullPage: true });
});

test("a aba oficial abre a conexão e tem os templates da Meta como sub-aba", async ({ page }) => {
  await page.goto("/app/connections");
  await page.getByRole("tab", { name: /API Oficial/i }).click();

  // A tela de conectar é a MESMA de antes — mudou o lugar, não o que ela faz.
  await expect(page.getByTestId("canal-oficial-root")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("tab", { name: /Templates da Meta/i })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/02-oficial-conexao.png`, fullPage: true });

  await page.getByRole("tab", { name: /Templates da Meta/i }).click();
  await expect(page.getByRole("tab", { name: /Templates da Meta/i })).toHaveAttribute(
    "data-state",
    "active",
  );
  await page.screenshot({ path: `${EVIDENCE}/03-oficial-templates.png`, fullPage: true });
});

test("a aba fica na URL — link colado abre onde deveria", async ({ page }) => {
  // Aba que só vive em `useState` transforma todo link salvo em "abre e procura
  // de novo". É também o que faz os redirects das rotas antigas funcionarem.
  await page.goto("/app/connections?aba=oficial&sub=templates");
  await expect(page.getByRole("tab", { name: /Templates da Meta/i })).toHaveAttribute(
    "data-state",
    "active",
  );
});

test("quem tinha o link antigo salvo não cai em 404", async ({ page }) => {
  await page.goto("/app/settings/canal-oficial");
  await page.waitForURL(/\/app\/connections\?aba=oficial/);
  await expect(page.getByTestId("canal-oficial-root")).toBeVisible({ timeout: 20_000 });

  await page.goto("/app/settings/templates");
  await page.waitForURL(/sub=templates/);
  await expect(page.getByRole("tab", { name: /Templates da Meta/i })).toHaveAttribute(
    "data-state",
    "active",
  );
});

test("o card em Configurações leva ao MESMO lugar, não a um segundo", async ({ page }) => {
  // O defeito era ter dois destinos para a mesma pergunta. Se este caso falhar
  // porque o card sumiu, tudo bem; se falhar porque ele leva a outra tela, o
  // problema voltou.
  await page.goto("/app/settings");
  const card = page.getByRole("link", { name: /Canal oficial/i });
  await expect(card).toBeVisible();
  await card.click();
  await page.waitForURL(/\/app\/connections/);
  await expect(page.getByTestId("canal-oficial-root")).toBeVisible({ timeout: 20_000 });
});

// ── Redes sociais por flag — o interruptor do addon #1 decidindo a descoberta ─
//
// Q3 da spec (CONFIRMADO): a aba `Redes sociais` nasce de `platform_config`
// (`MODULO_REDES_SOCIAIS = 'ligado'`), e desligado ela SOME — junto com o trecho
// de header que cita Instagram/Messenger, que entra na MESMA frase só quando a
// flag liga. O toggle é SQL de service role (a tabela não tem policy, 0341), no
// mesmo molde do update de `canais-baseline.spec.ts`: captura o estado inicial e
// RESTAURA no finally, porque a flag é estado da instalação, não do teste.

const CHAVE_DA_FLAG = "MODULO_REDES_SOCIAIS";

/** `.env.local` (molde de `canais-baseline`) com plano B `.env.e2e`, que é a
 * fonte do stack do e2e em worktree limpo — os dois existem na receita de
 * `e2e.yml` (ele mesmo faz `cp .env.e2e .env.local` antes dos seeds). */
function envDaSuporte(): Record<string, string> {
  const alvo = fs.existsSync(path.join(process.cwd(), ".env.local"))
    ? ".env.local"
    : ".env.e2e";
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(path.join(process.cwd(), alvo), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

type EstadoDaFlag = { existia: boolean; valor: string | null };

async function lerEstadoDaFlag(): Promise<EstadoDaFlag> {
  const env = envDaSuporte();
  const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const { data, error } = await svc
    .from("platform_config")
    .select("valor")
    .eq("chave", CHAVE_DA_FLAG);
  if (error) throw new Error(`ler a flag do módulo: ${error.message}`);
  return { existia: (data?.length ?? 0) > 0, valor: data?.[0]?.valor ?? null };
}

/** Devolve a instalação ao estado capturado — apagando a linha se ela não existia. */
async function restaurarEstadoDaFlag(estado: EstadoDaFlag): Promise<void> {
  const env = envDaSuporte();
  const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const { error } = estado.existia
    ? await svc
        .from("platform_config")
        .upsert({ chave: CHAVE_DA_FLAG, valor: estado.valor }, { onConflict: "chave" })
    : await svc.from("platform_config").delete().eq("chave", CHAVE_DA_FLAG);
  if (error) throw new Error(`restaurar a flag do módulo: ${error.message}`);
}

test("a aba Redes sociais nasce da flag: ligada aparece com o header, desligada some", async ({
  page,
}) => {
  const original = await lerEstadoDaFlag();
  try {
    // ── FLAG LIGADA ────────────────────────────────────────────────────────
    const env = envDaSuporte();
    const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
    const { error: erroLigar } = await svc
      .from("platform_config")
      .upsert({ chave: CHAVE_DA_FLAG, valor: "ligado" }, { onConflict: "chave" });
    if (erroLigar) throw new Error(`ligar a flag do módulo: ${erroLigar.message}`);

    await page.goto("/app/connections");
    await expect(page.getByRole("tab", { name: "Redes sociais" })).toBeVisible();
    // O header cresce a mesma frase (page.tsx): com a flag desligada ele é o de
    // sempre — o regex casa o trecho que só existe no modo ligado.
    await expect(page.getByText(/Instagram e seu Messenger/)).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/06-flag-ligada.png`, fullPage: true });

    // ── FLAG DESLIGADA ────────────────────────────────────────────────────
    // Apagar a linha = desligado (falha fechada: só `valor='ligado'` liga).
    const { error: erroDesligar } = await svc
      .from("platform_config")
      .delete()
      .eq("chave", CHAVE_DA_FLAG);
    if (erroDesligar) throw new Error(`desligar a flag do módulo: ${erroDesligar.message}`);

    await page.goto("/app/connections");
    await expect(page.getByRole("tab", { name: "Redes sociais" })).toHaveCount(0);
    await expect(page.getByText(/Instagram e seu Messenger/)).toHaveCount(0);
    await page.screenshot({ path: `${EVIDENCE}/07-flag-desligada.png`, fullPage: true });
  } finally {
    await restaurarEstadoDaFlag(original);
  }
});
