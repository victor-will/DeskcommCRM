/**
 * A TELA DE CONFIGURAÇÃO DO MENU — TRÊS ESTADOS PELA TELA, com prova visual
 * (plano Task 8).
 *
 * ─── O que esta spec fecha ───────────────────────────────────────────────────
 *
 * As três tasks anteriores construíram as portas (rota de toggle de 3 camadas,
 * CRUD de itens, entrada no catálogo); nenhuma dirigiu um navegador. O defeito
 * que só um caso assim fecha é a tela que MOSTRA um estado que a API não
 * aceita — e o caminho inverso: o interruptor que liga e nada muda. Aqui os
 * três estados do plano são percorridos de verdade:
 *
 *   1. "Menu desligado" — entrando pela PORTA (hub de Configurações), o que
 *      prova que a entrada do `catalogo.ts` existe para quem usa (módulo
 *      instalado é pré-condição: com ele desligado a porta some);
 *   2. "Ligado" — o clique passa pelas TRÊS camadas do gate da rota (módulo
 *      instalado + `settings.menu.concedido` + plano), e o reload prova que
 *      chegou ao banco, não só ao estado de React;
 *   3. "Editando item" — criar pela tela (POST da Task 7), conferir a
 *      pré-visualização (o texto da máquina, por construção) e abrir a edição.
 *
 * ─── Quem é quem ─────────────────────────────────────────────────────────────
 *
 * Quem usa esta tela é um manager de ORGANIZAÇÃO (o `manager` do seed, sem
 * MFA — o mesmo login da spec da Agenda). O `concedido` é escrito AQUI como
 * pré-condição de banco, porque quem o escreve no produto é o dono do
 * servidor (`PATCH /api/v1/admin/recursos-org/[id]`, Task 6/9) e esta spec
 * não é sobre a tela dele.
 *
 * ─── O que esta spec NÃO prova ──────────────────────────────────────────────
 *
 *  - O aviso "Aguardando ativação pela administração": é asserção do
 *    `page.test.tsx` (estado sem concedido), e forçá-lo aqui exigiria
 *    REVOGAR a concessão da org de teste no meio do banco compartilhado.
 *  - A instalação do módulo pela tela de admin (/admin/modulos): pré-condição
 *    de banco, como o `limparCredencial` do molde.
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { expect, test } from "./helpers/test";
import { lerCreds, type CredsE2E } from "./helpers/login-admin";

/**
 * ⚠️ SEM `APP_URL`: navegações relativas, o `baseURL` resolve (a lição medida
 * da spec de Tipos de agendamento — o fallback para `:3000` derruba a suite
 * inteira em bloco no CI).
 */
test.describe.configure({ timeout: 120_000 });

type Creds = CredsE2E & { org_id: string };

function credsComOrg(): Creds {
  const creds = lerCreds() as CredsE2E & { org_id?: string };
  if (!creds.org_id) throw new Error(".e2e-creds.json sem `org_id` — rode o seed de credenciais");
  if (!creds.users.manager) throw new Error(".e2e-creds.json sem o usuário `manager`");
  return creds as Creds;
}

/** Login de formulário do `manager` — sem MFA (molde da spec da Agenda). */
async function entrar(page: import("@playwright/test").Page, creds: Creds): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(creds.users.manager!.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

const EVIDENCIA = path.join(process.cwd(), "evidence", "menu-config");
function evidencia(nome: string): string {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return path.join(EVIDENCIA, nome);
}

/**
 * Pré-condições de banco (service role, mesmo critério do `limparCredencial`
 * do molde) e a RESTAURAÇÃO do que foi mudado — o banco é compartilhado.
 *
 * 1. `fn_menu_whatsapp_provisionar()`: as tabelas do módulo (só nascem na
 *    instalação — ADR-0002, fora do `baseline.sql`);
 * 2. `modulos_instalados`: linha `menu_whatsapp` `ativo` (Task 9 instala por
 *    `fn_modulo_instalar`; aqui é só o estado prévio, e a escrita direta é a
 *    mesma liberdade do resto do e2e);
 * 3. `settings.menu.concedido = true` com `enabled = false` (o estado 1), em
 *    merge RASO sobre o settings que a org já tem;
 * 4. `menu_itens` da org esvaziada (o estado 3 cria o item pela tela).
 */
async function preparar(): Promise<{
  creds: Creds;
  restaurar: () => Promise<void>;
}> {
  const local = credenciaisSupabaseDeTeste(); // recusa credenciais do ambiente real
  const db = createClient(local.url, local.serviceRole, { auth: { persistSession: false } });
  const creds = credsComOrg();

  // A TABELA só nasce quando o módulo provisiona (ADR-0002: `menu_itens` não
  // está no `baseline.sql` do e2e). A provisionadora é `security definer`
  // concedida só a `service_role` (a própria migration 9079 faz revoke de
  // public/anon/authenticated) — este cliente é o único que pode chamar, e ela
  // é idempotente (`create table if not exists`). Escrever a linha de
  // `modulos_instalados` à mão é o mesmo tipo de pré-condição de banco desta
  // spec; a instalação PELA TELA é da Task 9 (fluxo `fn_modulo_instalar` com
  // ator e operação — escopo dela, não da tela).
  const provisionado = await db.rpc("fn_menu_whatsapp_provisionar");
  if (provisionado.error) throw provisionado.error;

  // O PostgREST recarrega o schema cache DEPOIS do DDL (assíncrono, via event
  // trigger): a primeira query logo após o rpc podia cair na janela e responder
  // PGRST205 "Could not find the table 'public.menu_itens'" — medido nesta
  // sessão (tabela no banco via psql, REST ainda sem ela). Esperar o cache
  // ver a tabela é condição do AMBIENTE, não do produto.
  for (let tentativa = 0; tentativa < 15; tentativa++) {
    const cache = await db
      .from("menu_itens" as never)
      .select("id")
      .limit(1);
    if (!cache.error) break;
    if (cache.error.code !== "PGRST205") throw cache.error;
    if (tentativa === 14) {
      throw new Error(
        `menu_itens não apareceu no schema cache do PostgREST: ${cache.error.message}`,
      );
    }
    await new Promise((resolver) => setTimeout(resolver, 1_000));
  }

  const moduloAnterior = await db
    .from("modulos_instalados")
    .select("modulo, estado")
    .eq("modulo", "menu_whatsapp")
    .maybeSingle();
  if (moduloAnterior.error) throw moduloAnterior.error;

  const org = await db.from("organizations").select("settings").eq("id", creds.org_id).single();
  if (org.error) throw org.error;
  const settingsAnterior = org.data.settings as Record<string, unknown> | null;

  const itensAnteriores = await db
    .from("menu_itens" as never)
    .select("*")
    .eq("organization_id", creds.org_id);
  if (itensAnteriores.error) throw itensAnteriores.error;

  const instalado = await db
    .from("modulos_instalados")
    .upsert({ modulo: "menu_whatsapp", estado: "ativo" }, { onConflict: "modulo" });
  if (instalado.error) throw instalado.error;

  const menu = {
    ...((settingsAnterior?.menu as Record<string, unknown> | undefined) ?? {}),
    concedido: true,
    enabled: false,
  };
  const concedido = await db
    .from("organizations")
    .update({ settings: { ...(settingsAnterior ?? {}), menu } as never })
    .eq("id", creds.org_id);
  if (concedido.error) throw concedido.error;

  const limpo = await db
    .from("menu_itens" as never)
    .delete()
    .eq("organization_id", creds.org_id);
  if (limpo.error) throw limpo.error;

  async function restaurar(): Promise<void> {
    const voltaSettings = await db
      .from("organizations")
      .update({ settings: (settingsAnterior ?? {}) as never })
      .eq("id", creds.org_id);
    if (voltaSettings.error) throw voltaSettings.error;

    if (moduloAnterior.data) {
      const voltaModulo = await db
        .from("modulos_instalados")
        .update({ estado: moduloAnterior.data.estado })
        .eq("modulo", "menu_whatsapp");
      if (voltaModulo.error) throw voltaModulo.error;
    } else {
      const foraModulo = await db.from("modulos_instalados").delete().eq("modulo", "menu_whatsapp");
      if (foraModulo.error) throw foraModulo.error;
    }

    // Restaurar é VOLVER AO ESTADO CAPTURADO — e isso começa por APAGAR as
    // linhas que o teste criou: só re-inserir as capturadas colidia com elas
    // (medido: 23505 em organization_id+ordem NA RESTAURAÇÃO, derrubando um
    // caso que tinha passado inteiro).
    const limpezaFinal = await db
      .from("menu_itens" as never)
      .delete()
      .eq("organization_id", creds.org_id);
    if (limpezaFinal.error) throw limpezaFinal.error;

    const linhas = (itensAnteriores.data ?? []) as unknown as Record<string, unknown>[];
    if (linhas.length > 0) {
      const voltaItens = await db.from("menu_itens" as never).insert(linhas as never);
      if (voltaItens.error) throw voltaItens.error;
    }
  }

  return { creds, restaurar };
}

test("três estados pela tela: desligado → ligado → editando item (prova visual)", async ({
  page,
}) => {
  const { creds, restaurar } = await preparar();
  try {
    await entrar(page, creds);

    // ── Estado 1: DESLIGADO, chegando pela PORTA ────────────────────────────
    // Pela porta e não pela URL: ter tela e ser alcançável são coisas
    // diferentes. O hub é a porta do grupo "organizacao", e a entrada só
    // renderiza com o módulo instalado (a pré-condição de cima).
    await page.goto("/app/settings");
    const porta = page.getByRole("link", { name: /Menu do WhatsApp/ }).first();
    await expect(
      porta,
      "a porta do menu não aparece no hub de Configurações — catálogo ou módulo",
    ).toBeVisible({ timeout: 20_000 });
    await porta.click();
    await expect(page).toHaveURL(/\/app\/settings\/tenant\/menu/, { timeout: 20_000 });

    const estado = page.getByTestId("estado-do-menu");
    await expect(estado).toHaveText("Menu desligado", { timeout: 15_000 });
    await expect(page.getByRole("switch"), "com concessão, a chave responde").toBeEnabled();
    await page.screenshot({ path: evidencia("1-desligado.png"), fullPage: true });

    // ── Estado 2: LIGADO — o clique passa pelo gate de 3 camadas ────────────
    await page.getByRole("switch").click();
    await expect(
      estado,
      "cliquei na chave e o estado não mudou — o gate recusou (módulo/concessão/plano?)",
    ).toHaveText("Ligado", { timeout: 15_000 });
    await page.screenshot({ path: evidencia("2-ligado.png"), fullPage: true });

    // Reload: medir estado de React não conta — o valor tem de estar no banco.
    await page.reload();
    await expect(estado, "o menu voltou desligado no reload — não gravou").toHaveText("Ligado", {
      timeout: 15_000,
    });

    // ── Estado 3: EDITANDO ITEM — criar pela tela e abrir a edição ─────────
    const rotulo = `Horários E2E ${Date.now().toString().slice(-6)}`;
    await page.getByTestId("adicionar-item").click();
    await expect(page.getByTestId("form-item")).toBeVisible();
    await page.getByTestId("item-rotulo").fill(rotulo);
    await page.getByTestId("item-resposta").fill("Seg a sex, das 9h às 18h.");
    await page.getByTestId("salvar-item").click();

    const linha = page
      .getByTestId("lista-de-itens")
      .getByRole("listitem")
      .filter({ hasText: rotulo });
    await expect(linha, "criei o item e ele não apareceu na lista").toBeVisible({
      timeout: 15_000,
    });

    // A pré-visualização é o MESMO texto que a máquina manda (montarMenu):
    // cumprimento + a linha do item novo, na ordem da lista.
    const previsao = page.getByTestId("bloco-previsao");
    await expect(previsao).toContainText("responda com o número", { timeout: 10_000 });
    await expect(previsao).toContainText(rotulo);

    // Abrir a edição do item recém-criado = o estado "editando item".
    await linha.getByRole("button", { name: "Editar" }).click();
    await expect(page.getByTestId("form-item")).toBeVisible();
    await expect(page.getByTestId("item-rotulo")).toHaveValue(rotulo);
    await page.screenshot({ path: evidencia("3-editando-item.png"), fullPage: true });
  } finally {
    await restaurar();
  }
});
