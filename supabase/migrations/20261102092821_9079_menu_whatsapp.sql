-- manifest: menu de texto sem IA (módulo menu_whatsapp): coluna de recursos por plano e provisionadora que cria menu_itens/menu_sessoes com RLS só onde o módulo está instalado (ADR-0002)
-- 9079 — o schema do menu nasce na instalação do módulo, não no baseline para todo mundo.
--
-- Duas peças, e a ordem é a da dependência delas:
--
--   1. `cobranca_planos.recursos` — a camada (a) da ativação em 3 camadas: o
--      que o PLANO concede. O default traz os dois recursos da Peça A/B
--      (`menu_whatsapp`, `agenda_online`) para o plano criado ANTES desta
--      migration continuar concedendo o que sempre concedeu — e o vocabulário
--      é o do type `Recurso` (lib/menu/recursos.ts, Task 6). Quem não tem
--      linha em `cobranca_assinaturas` é isento: semântica da própria tabela,
--      não deste default.
--
--   2. `fn_menu_whatsapp_provisionar()` — a provisionadora do módulo
--      (ADR-0002 D2/D4/D5): `menu_itens` e `menu_sessoes` nascem SÓ onde o
--      módulo está instalado (quem não instala não carrega as tabelas dele).
--      Sem parâmetro; `security definer` com EXECUTE só de `service_role`,
--      revogado nas DUAS origens de grant (`public, anon, authenticated`); e o
--      corpo termina em `fn_proteger_modulo_provisionado()` para a proteção
--      acontecer na MESMA transação da criação.
--
-- As policies seguem o molde de `automation_rules` (select para membro da
-- organização, escrita manager+ — a mesma régua da tela de configuração), e
-- cada `create policy` ocupa DUAS linhas de propósito (#1906): o `update.sh`
-- de v1.39.0 a v1.63.0 lê as regras do TEXTO do baseline (nome e tabela na
-- MESMA linha), e uma policy visível daquele jeito faria a conferência cobrar
-- tabela de módulo em instalação SEM o módulo — o incidente #1893/#1897, com
-- honorários.
alter table public.cobranca_planos
  add column if not exists recursos text[] not null default '{menu_whatsapp,agenda_online}';

comment on column public.cobranca_planos.recursos is
  'Recursos que o plano concede (camada do plano na ativação em 3 camadas). Default com os dois recursos da Peça A/B para o plano legado valer o de sempre; quem não tem assinatura é isenta (lib/menu/recursos.ts).';

create or replace function public.fn_menu_whatsapp_provisionar()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  -- ─── o cardápio da organização ────────────────────────────────────────────
  create table if not exists public.menu_itens (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,

    -- A numeração que o cliente digita. A `unique` por organização é o que
    -- impede dois itens "3" no mesmo menu — a máquina lê por `ordem`.
    ordem integer not null,
    rotulo text not null,

    -- `text` + CHECK, não enum (doutrina: enum é difícil de estender).
    tipo text not null check (tipo in ('texto', 'consulta')),

    -- Resposta fixa quando o item é texto. Nulo quando é `consulta`: ali a
    -- resposta vem do banco (horários, preços, link), não deste campo.
    resposta_texto text,
    consulta text check (consulta in ('horarios_hoje', 'precos', 'link_agenda')),

    ativo boolean not null default true,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    unique (organization_id, ordem)
  );

  -- ─── em que nível da máquina o contato está ───────────────────────────────
  create table if not exists public.menu_sessoes (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    -- Uma sessão POR contato da organização (unique abaixo): o estado é do
    -- contato, não da conversa — ele pode recomeçar noutra conversa e a
    -- máquina continua de onde parou.
    contact_id uuid not null references public.contacts(id) on delete cascade,
    -- Contexto em que a máquina rodou. `set null`: apagar a conversa não
    -- apaga o estado do contato (mesma decisão de `sales.appointment_id`).
    conversation_id uuid references public.conversations(id) on delete set null,
    channel_session_id uuid,

    -- Vocabulário da máquina (Task 3): idle, menu, aguardando_servico,
    -- aguardando_dia, aguardando_horario. `text` + default, sem CHECK: a
    -- máquina pode ganhar estado novo sem migration.
    estado text not null default 'idle',
    dados jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),

    unique (organization_id, contact_id)
  );

  -- ── privilégio do tamanho do uso (9037, decisão 219 = A) ──────────────────
  -- Tabela nova em `public` nasce com o default ACL do Supabase — e depois do
  -- corte de 30/10/2026 nasce SEM nada para os papéis. `revoke all` primeiro
  -- fixa o mesmo estado nos dois mundos; o grant é o que as policies
  -- permissivas daqui pressupõem: authenticated com os quatro comandos,
  -- service_role com o que o servidor faz, anon com nada (a RLS não tira
  -- privilégio, só nega linha — e o revoke abaixo tira a linha inteira).
  revoke all on table public.menu_itens from anon, authenticated, service_role;
  grant select, insert, update, delete on table public.menu_itens to authenticated, service_role;
  revoke all on table public.menu_sessoes from anon, authenticated, service_role;
  grant select, insert, update, delete on table public.menu_sessoes to authenticated, service_role;

  -- ── RLS nas duas tabelas (D5: aqui, e não pela rotina automática) ──────────
  -- Molde das policies de `automation_rules` (baseline ~5865): select para
  -- membro da organização; insert/update/delete manager+ — a mesma régua da
  -- tela de configuração (`requireRole("manager")`). A rotina 0325 só enxerga
  -- tabela com RLS DESLIGADA; ligando aqui, a decisão do módulo prevalece —
  -- e as travas do suporte continuam vindo pelo `perform` do fim.
  alter table public.menu_itens enable row level security;

  drop policy if exists menu_itens_select on public.menu_itens;
  -- Cada `create policy` deste corpo ocupa DUAS linhas de propósito (#1906):
  -- o `update.sh` de v1.39.0 a v1.63.0 lê as regras do TEXTO do baseline,
  -- nome e tabela na MESMA linha, e cobraria estas policies em instalação sem
  -- o módulo (o incidente #1893/#1897, com honorários). A forma do texto é o
  -- conserto que alcança quem atualiza com o script antigo no disco.
  create policy menu_itens_select
    on public.menu_itens
    for select using (
      (organization_id in (select public.fn_user_org_ids()))
      or public.fn_is_platform_admin()
    );

  drop policy if exists menu_itens_manager_write on public.menu_itens;
  create policy menu_itens_manager_write
    on public.menu_itens
    using (
      public.fn_is_platform_admin_full()
      or ((organization_id in (select public.fn_user_org_ids()))
          and public.fn_role_at_least(organization_id, 'manager'))
    )
    with check (
      public.fn_is_platform_admin_full()
      or ((organization_id in (select public.fn_user_org_ids()))
          and public.fn_role_at_least(organization_id, 'manager'))
    );

  alter table public.menu_sessoes enable row level security;

  drop policy if exists menu_sessoes_select on public.menu_sessoes;
  create policy menu_sessoes_select
    on public.menu_sessoes
    for select using (
      (organization_id in (select public.fn_user_org_ids()))
      or public.fn_is_platform_admin()
    );

  drop policy if exists menu_sessoes_manager_write on public.menu_sessoes;
  create policy menu_sessoes_manager_write
    on public.menu_sessoes
    using (
      public.fn_is_platform_admin_full()
      or ((organization_id in (select public.fn_user_org_ids()))
          and public.fn_role_at_least(organization_id, 'manager'))
    )
    with check (
      public.fn_is_platform_admin_full()
      or ((organization_id in (select public.fn_user_org_ids()))
          and public.fn_role_at_least(organization_id, 'manager'))
    );

  -- D5: a proteção na MESMA transação. A RLS acima já está ligada (a rotina
  -- 0325 só enxerga tabela com RLS desligada) e o `anon` já saiu das duas
  -- tabelas (revoke + grant acima) — o que sobra dela são as três travas
  -- restritivas do suporte, que leem o privilégio de `authenticated` para
  -- decidir entre as três e o contrato server-only.
  perform public.fn_proteger_modulo_provisionado();

  return jsonb_build_object(
    'modulo', 'menu_whatsapp',
    'tabelas', array['menu_itens', 'menu_sessoes']
  );
end
$f$;

-- As DUAS origens de EXECUTE, e não uma: o grant DIRETO do `alter default
-- privileges … to anon` do baseline não sai com `revoke from public`, e o
-- grant a PUBLIC (do qual anon herda) não sai com `revoke from anon` — as
-- migrations 0108/0116 já pagaram essa conta. `authenticated` entra no mesmo
-- revoke porque o default privileges alcança ele também: provisionadora
-- executável por usuário logado é DDL arbitrária pela sessão de qualquer
-- tenant (D4).
revoke execute on function public.fn_menu_whatsapp_provisionar() from public, anon, authenticated;
grant execute on function public.fn_menu_whatsapp_provisionar() to service_role;

comment on function public.fn_menu_whatsapp_provisionar() is
  'Provisiona o schema do módulo menu_whatsapp (ADR-0002 D2): menu_itens e menu_sessoes, só onde o módulo está instalado. Sem parâmetro e com EXECUTE só de service_role (D4); grants do tamanho do uso (9037) e policies no molde de automation_rules (select de membro, escrita manager+); termina em fn_proteger_modulo_provisionado() para a proteção na mesma transação (D5).';
