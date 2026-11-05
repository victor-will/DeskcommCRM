import { beforeAll, describe, expect, it } from "vitest";

import {
  columnExists,
  countAs,
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_CONTACT_PROBE,
  GOV_MANAGER,
  GOV_ORG,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * RLS das tabelas do módulo `menu_whatsapp` — as duas que
 * `fn_menu_whatsapp_provisionar()` (migration 9079, ADR-0002 D2) cria só onde
 * o módulo está instalado. As tabelas NÃO vêm do baseline: este arquivo as
 * provisiona de verdade no `beforeAll`, como o irmão
 * `adr-0002-d8-varreduras-com-os-modulos-instalados.test.ts` faz.
 *
 * O que se prova, com JWT real (`set role authenticated` + claims — o mesmo
 * caminho do PostgREST):
 *   - membro da organização LÊ e ESCREVE na própria (insert/update/delete);
 *   - `agent` lê mas não escreve: escrita é manager+, o molde das policies de
 *     `automation_rules` (baseline ~5865) e a mesma régua da tela de
 *     configuração (`requireRole("manager")`);
 *   - outra organização não lê (contagem cross-org = 0 nas duas direções)
 *     nem escreve (insert/update na org vizinha recusado pela policy);
 *   - `anon` não alcança nada (sem privilégio de tabela — permission denied);
 *   - provisionar de novo não muda linhas nem policies (idempotência, D5/D6);
 *   - `cobranca_planos.recursos` nasce com o default dos dois recursos da
 *     Peça A/B (a outra peça desta mesma migration).
 *
 * A sessão do contato (`menu_sessoes`) é seedada com linha REAL nas DUAS
 * organizações: sem a linha do vizinho a contagem cross-org seria 0 = 0 por
 * ausência de dado.
 */

// Fixture própria (namespace ffffffff) — org B só p/ provar não-vazamento.
const MENU_ORG_B = "ffffffff-0000-4000-8000-000000000011";
const MENU_MANAGER_B = "ffffffff-1111-4000-8000-000000000011";
const MENU_CONTACT_B = "ffffffff-3333-4000-8000-000000000011";

// Linhas reais (o `sql()` roda como superuser do container — o mesmo efeito
// prático do service_role em produção; ver o rodapé de webhooks-rls.test.ts).
const MENU_ITEM_A = "ffffffff-5555-4000-8000-000000000011";
const MENU_ITEM_B = "ffffffff-5555-4000-8000-000000000012";
const MENU_ITEM_UPDATE = "ffffffff-5555-4000-8000-000000000013";
const MENU_ITEM_DELETE = "ffffffff-5555-4000-8000-000000000014";
const MENU_ITEM_INSERIDO = "ffffffff-5555-4000-8000-000000000015";
const MENU_ITEM_AGENTE = "ffffffff-5555-4000-8000-000000000016";
const MENU_ITEM_INTRUSO = "ffffffff-5555-4000-8000-000000000017";
const MENU_SESSAO_A = "ffffffff-5555-4000-8000-000000000021";
const MENU_SESSAO_B = "ffffffff-5555-4000-8000-000000000022";
const MENU_SESSAO_INSERIDA = "ffffffff-5555-4000-8000-000000000023";

beforeAll(() => {
  seedGov();
  // As tabelas não vêm do baseline: nascem na provisionadora (ADR-0002 D2).
  sql(`select public.fn_menu_whatsapp_provisionar();`);
  sql(`
    insert into auth.users (id, email)
      values ('${MENU_MANAGER_B}', 'menu-manager-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${MENU_ORG_B}', 'gov-inv-menu-b', 'Gov Invariant Menu Org B', 'Gov Inv Menu B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MENU_MANAGER_B}', '${MENU_ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${MENU_CONTACT_B}', '${MENU_ORG_B}', 'Gov Invariant Menu Contact B')
      on conflict do nothing;

    insert into public.menu_itens (id, organization_id, ordem, rotulo, tipo, consulta)
      values
        ('${MENU_ITEM_A}', '${GOV_ORG}', 1, 'Horários de hoje', 'consulta', 'horarios_hoje'),
        ('${MENU_ITEM_UPDATE}', '${GOV_ORG}', 2, 'Preços dos serviços', 'consulta', 'precos'),
        ('${MENU_ITEM_DELETE}', '${GOV_ORG}', 3, 'Marcar horário', 'texto', null),
        ('${MENU_ITEM_B}', '${MENU_ORG_B}', 1, 'Item da org vizinha', 'texto', null);
    insert into public.menu_sessoes (id, organization_id, contact_id, estado)
      values
        ('${MENU_SESSAO_A}', '${GOV_ORG}', '${GOV_CONTACT_1}', 'menu'),
        ('${MENU_SESSAO_B}', '${MENU_ORG_B}', '${MENU_CONTACT_B}', 'idle');
  `);
});

describe("menu_itens + menu_sessoes — RLS (migration 9079, provisionadora do módulo)", () => {
  it("membro lê as linhas da própria organização", () => {
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.menu_itens where id = '${MENU_ITEM_A}';`),
    ).toBe(1);
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.menu_sessoes where id = '${MENU_SESSAO_A}';`),
    ).toBe(1);
    // `agent` também é membro: o SELECT é da organização inteira (molde de
    // automation_rules), só a ESCRITA que é manager+.
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.menu_itens where id = '${MENU_ITEM_A}';`),
    ).toBe(1);
  });

  it("membro escreve na própria organização (insert, update, delete)", () => {
    expect(
      writeCountAs(
        GOV_MANAGER,
        `insert into public.menu_itens (id, organization_id, ordem, rotulo, tipo)
          values ('${MENU_ITEM_INSERIDO}', '${GOV_ORG}', 4, 'Falar com alguém', 'texto')`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.menu_itens set rotulo = 'Preços dos serviços' where id = '${MENU_ITEM_UPDATE}'`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(GOV_MANAGER, `delete from public.menu_itens where id = '${MENU_ITEM_DELETE}'`),
    ).toBe(1);
    expect(
      writeCountAs(
        GOV_MANAGER,
        `insert into public.menu_sessoes (id, organization_id, contact_id, estado)
          values ('${MENU_SESSAO_INSERIDA}', '${GOV_ORG}', '${GOV_CONTACT_PROBE}', 'idle')`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.menu_sessoes set estado = 'aguardando_servico' where id = '${MENU_SESSAO_A}'`,
      ),
    ).toBe(1);
  });

  it("agent não escreve — escrita é manager+ (molde de automation_rules)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.menu_itens (id, organization_id, ordem, rotulo, tipo)
          values ('${MENU_ITEM_AGENTE}', '${GOV_ORG}', 5, 'Probe do agente', 'texto')`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.menu_sessoes set estado = 'idle' where id = '${MENU_SESSAO_A}'`,
      ),
    ).toBe(0);
  });

  it("outra organização não lê as linhas da org A — e a contagem inteira do vizinho é só a dele", () => {
    expect(
      countAs(MENU_MANAGER_B, `select count(*) from public.menu_itens where id = '${MENU_ITEM_A}';`),
    ).toBe(0);
    expect(
      countAs(
        MENU_MANAGER_B,
        `select count(*) from public.menu_sessoes where id = '${MENU_SESSAO_A}';`,
      ),
    ).toBe(0);
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.menu_itens where id = '${MENU_ITEM_B}';`),
    ).toBe(0);
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.menu_sessoes where id = '${MENU_SESSAO_B}';`),
    ).toBe(0);

    // A contagem SEM filtro: o vizinho vê só o que é dele, o membro da org A
    // vê só o da org A (o item de delete já saiu no caso de escrita acima).
    expect(countAs(MENU_MANAGER_B, `select count(*) from public.menu_itens;`)).toBe(1);
    expect(countAs(GOV_MANAGER, `select count(*) from public.menu_itens;`)).toBe(3);
  });

  it("outra organização não ESCREVE na org A", () => {
    expect(
      writeCountAs(
        MENU_MANAGER_B,
        `insert into public.menu_itens (id, organization_id, ordem, rotulo, tipo)
          values ('${MENU_ITEM_INTRUSO}', '${GOV_ORG}', 99, 'Intruso', 'texto')`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        MENU_MANAGER_B,
        `update public.menu_sessoes set estado = 'idle' where id = '${MENU_SESSAO_A}'`,
      ),
    ).toBe(0);
  });

  it("anon não alcança nenhuma das duas (permission denied)", () => {
    // O revoke de `anon` dentro da provisionadora tira o PRIVILÉGIO (a D5 cobra
    // as duas coisas: RLS ligada e anon sem alcance) — por isso aqui o erro é
    // de privilégio, e não uma contagem zero vinda da RLS.
    expect(() => sql(`set role anon; select count(*) from public.menu_itens;`)).toThrow();
    expect(() => sql(`set role anon; select count(*) from public.menu_sessoes;`)).toThrow();
  });

  it("provisionar de novo não muda linhas nem policies (idempotência)", () => {
    const estado = () =>
      sql(`
        select (select count(*) from public.menu_itens)
            || '|' || (select count(*) from public.menu_sessoes)
            || '|' || (select count(*) from pg_policy p
                         join pg_class c on c.oid = p.polrelid
                        where c.relname in ('menu_itens', 'menu_sessoes'));
      `);
    const antes = estado();
    sql(`select public.fn_menu_whatsapp_provisionar();`);
    expect(estado(), "a segunda chamada mudou linhas ou policies — ela tem que convergir").toBe(
      antes,
    );
  });
});

describe("cobranca_planos.recursos — a outra peça da migration 9079", () => {
  it("existe, não é nula e nasce com os dois recursos da Peça A/B", () => {
    expect(columnExists("cobranca_planos", "recursos")).toBe(true);
    const coluna = sql(`
      select is_nullable || '|' || coalesce(column_default, '')
        from information_schema.columns
       where table_schema = 'public' and table_name = 'cobranca_planos'
         and column_name = 'recursos';
    `);
    expect(coluna.startsWith("NO|"), `coluna de recurso do plano: ${coluna}`).toBe(true);
    expect(coluna).toContain("menu_whatsapp");
    expect(coluna).toContain("agenda_online");
  });
});
