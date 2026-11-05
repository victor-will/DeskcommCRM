"use client";
import type { ItemDoMenu as ItemDaApi } from "@/app/api/v1/menu/itens/route";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { ApiSuccess } from "@/lib/api/wrappers";
import { montarMenu } from "@/lib/menu/maquina";

// A linha de `menu_itens` com o nome LOCAL (o tipo `ItemDoMenu` também existe
// em `lib/menu/maquina.ts`, com outro formato — contexto da máquina —, e na
// `curso/montar.ts`). A página importa daqui.
export type { ItemDaApi };

interface Props {
  /** `settings.menu.concedido` — a camada (b) da ativação (Task 6). */
  concedido: boolean;
  /** `settings.menu.enabled` — o que o cliente ligou (ou tentou ligar). */
  enabled: boolean;
  /** `organizations.slug` — só existe o link público quando ele existe (B12). */
  slug: string | null;
  itens: ItemDaApi[];
  /** Cortesia de tela: a rota cobra o papel de novo em cada mutação. */
  podeEditar: boolean;
  /** Falha ao LER `settings` — não é "sem concessão", é "não consegui ler". */
  erroConfiguracao: string | null;
  /** Falha ao LER os itens — lista vazia e leitura falhada são fatos diferentes. */
  erroItens: string | null;
}

/** O rascunho do formulário (novo ou edição) — `id: null` = novo item. */
interface Rascunho {
  id: string | null;
  ordem: string;
  rotulo: string;
  tipo: "texto" | "consulta";
  resposta_texto: string;
  consulta: string;
}

const CONSULTAS = [
  { valor: "horarios_hoje", rotulo: "Horários de hoje" },
  { valor: "precos", rotulo: "Preços dos serviços" },
  { valor: "link_agenda", rotulo: "Link da agenda online" },
] as const;

const porOrdem = (a: ItemDaApi, b: ItemDaApi) => a.ordem - b.ordem;

/**
 * Teclas com precedência na MÁQUINA (`lib/menu/maquina.ts`: `3` e `0` são
 * respondidos pela máquina antes de qualquer item de `menu_itens` — decisão
 * travada na Task 7). Um item criado com uma destas ordens ficaria INVISÍVEL:
 * o cliente digita 3/0 e a máquina responde, o item nunca é alcançado.
 */
export const TECLAS_RESERVADAS: readonly number[] = [0, 3];

/**
 * Próxima ordem livre para um item NOVO: `máximo + 1` (a régua de sempre,
 * monotônica) pulando as teclas reservadas da máquina. Pura de propósito —
 * testada direto em `page.test.tsx`.
 */
export function proximaOrdemLivre(itens: ReadonlyArray<{ ordem: number }>): number {
  let candidato = itens.reduce((max, i) => Math.max(max, i.ordem), -1) + 1;
  while (TECLAS_RESERVADAS.includes(candidato)) candidato += 1;
  return candidato;
}

export function MenuConfigClient(props: Props) {
  const t = useT();
  const router = useRouter();

  const [enabled, setEnabled] = useState(props.enabled);
  const [itens, setItens] = useState<ItemDaApi[]>(() => [...props.itens].sort(porOrdem));
  const [salvando, setSalvando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);
  const [erroForm, setErroForm] = useState<string | null>(null);

  // `concedido` NÃO tem estado local: quem o muda é a administração (rota da
  // Task 6), nunca esta tela — ele é sempre o do servidor. O estado nasce dos
  // props e passa a ser atualizado pelas RESPOSTAS das mutações que ESTA tela
  // faz (o mesmo molde de `settings/proposals/_client.tsx`, que também não
  // re-sincroniza do servidor depois do mount): `router.refresh()` abaixo
  // re-renderiza o servidor para o SIDEBAR/⌘K e para a próxima montagem, não
  // para este estado — uma mutação que respondeu bem já deixou o local certo.

  const chavePresa = salvando || props.erroConfiguracao !== null;
  const podeMexer = props.podeEditar && props.erroConfiguracao === null;

  /** Estado em 3 valores — sem concessão manda sobre o `enabled` gravado. */
  const estado: "aguardando" | "desligado" | "ligado" = !props.concedido
    ? "aguardando"
    : enabled
      ? "ligado"
      : "desligado";

  async function alternar(proximo: boolean) {
    if (chavePresa) return;
    setSalvando(true);
    try {
      await apiClient.patch<ApiSuccess<{ enabled: boolean }>>("/api/v1/settings/menu", {
        enabled: proximo,
      });
      setEnabled(proximo);
      // O menu (sidebar, ⌘K) vem do layout de `/app`, que não re-renderiza numa
      // navegação comum — mesmo motivo de `settings/proposals/_client.tsx`.
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  function abrirNovo() {
    // Lista vazia SEM seed dava ordem 0 — tecla da máquina (achado da
    // revisão): `proximaOrdemLivre` pula {0, 3}.
    const proxima = proximaOrdemLivre(itens);
    setErroForm(null);
    setRascunho({
      id: null,
      ordem: String(proxima),
      rotulo: "",
      tipo: "texto",
      resposta_texto: "",
      consulta: "horarios_hoje",
    });
  }

  function abrirEdicao(item: ItemDaApi) {
    setErroForm(null);
    setRascunho({
      id: item.id,
      ordem: String(item.ordem),
      rotulo: item.rotulo,
      tipo: item.tipo,
      resposta_texto: item.resposta_texto ?? "",
      consulta: item.consulta ?? "horarios_hoje",
    });
  }

  async function salvar() {
    if (rascunho === null || ocupado) return;
    const ordem = Number(rascunho.ordem);
    if (!Number.isInteger(ordem) || ordem < 0) {
      setErroForm(t("A ordem precisa ser um número inteiro maior ou igual a zero."));
      return;
    }
    if (rascunho.rotulo.trim() === "") {
      setErroForm(t("Informe o texto da opção que o cliente vai escolher."));
      return;
    }
    const corpo = {
      ordem,
      rotulo: rascunho.rotulo.trim(),
      tipo: rascunho.tipo,
      resposta_texto: rascunho.tipo === "texto" ? rascunho.resposta_texto.trim() || null : null,
      consulta: rascunho.tipo === "consulta" ? rascunho.consulta : null,
    };
    setOcupado(true);
    try {
      if (rascunho.id === null) {
        const res = await apiClient.post<ApiSuccess<ItemDaApi>>("/api/v1/menu/itens", corpo);
        setItens((atual) => [...atual, res.data].sort(porOrdem));
      } else {
        const res = await apiClient.patch<ApiSuccess<ItemDaApi>>(
          `/api/v1/menu/itens/${rascunho.id}`,
          corpo,
        );
        setItens((atual) => atual.map((i) => (i.id === res.data.id ? res.data : i)).sort(porOrdem));
      }
      setRascunho(null);
      setErroForm(null);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  async function remover(id: string) {
    if (ocupado) return;
    setOcupado(true);
    try {
      await apiClient.delete<ApiSuccess<{ id: string }>>(`/api/v1/menu/itens/${id}`);
      setItens((atual) => atual.filter((i) => i.id !== id));
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  /**
   * Renumerar troca as POSIÇÕES de dois itens — e `unique (organization_id,
   * ordem)` recusa a troca direta (a primeira metade colidiria com a segunda).
   * O caminho é o passeio com temporário: A → livre (max+1, livre por
   * construção), B → ordem de A, A → ordem de B. Três PATCH na mesma direção,
   * cada um entrando num espaço que a etapa anterior abriu.
   */
  async function mover(indice: number, direcao: -1 | 1) {
    if (ocupado) return;
    const alvo = indice + direcao;
    if (alvo < 0 || alvo >= itens.length) return;
    const a = itens[indice]!;
    const b = itens[alvo]!;
    const livre = itens.reduce((max, i) => Math.max(max, i.ordem), -1) + 1;
    setOcupado(true);
    try {
      const temporario = await apiClient.patch<ApiSuccess<ItemDaApi>>(
        `/api/v1/menu/itens/${a.id}`,
        { ordem: livre },
      );
      const bDeVolta = await apiClient.patch<ApiSuccess<ItemDaApi>>(`/api/v1/menu/itens/${b.id}`, {
        ordem: a.ordem,
      });
      const aFinal = await apiClient.patch<ApiSuccess<ItemDaApi>>(
        `/api/v1/menu/itens/${temporario.data.id}`,
        { ordem: b.ordem },
      );
      setItens((atual) =>
        atual
          .map((i) => {
            if (i.id === aFinal.data.id) return aFinal.data;
            if (i.id === bDeVolta.data.id) return bDeVolta.data;
            return i;
          })
          .sort(porOrdem),
      );
      router.refresh();
    } catch (e) {
      showApiError(e);
      // Passeio interrompido no meio: o temporário pode ter ficado gravado, e o
      // estado local não volta sozinho — a LISTA é relida da rota (o refresh do
      // servidor não re-escreve este estado, ver o comentário do topo).
      try {
        const res = await apiClient.get<ApiSuccess<{ itens: ItemDaApi[] }>>("/api/v1/menu/itens");
        setItens([...res.data.itens].sort(porOrdem));
      } catch {
        // Sem a releitura também: o próximo refresh/navegação re-monta com o
        // servidor. O erro da mutação já foi mostrado acima.
      }
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6" data-testid="menu-config">
      {/* ── 1. Status em 3 estados + a chave ─────────────────────────────── */}
      <section className="space-y-3" data-testid="bloco-status">
        {props.erroConfiguracao !== null ? (
          <div
            role="alert"
            data-testid="erro-de-leitura"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            {t("Não foi possível ler a configuração do menu. Recarregue a página e tente de novo.")}
          </div>
        ) : (
          <>
            <p data-testid="estado-do-menu" className="text-lg font-semibold">
              {estado === "aguardando"
                ? t("Aguardando ativação pela administração")
                : estado === "ligado"
                  ? t("Ligado")
                  : t("Menu desligado")}
            </p>
            {estado === "aguardando" ? (
              <div
                role="note"
                data-testid="aviso-sem-concessao"
                className="rounded-md border bg-muted p-3 text-sm text-muted-foreground"
              >
                {t(
                  "Ainda não concedido pela administração desta instalação. Assim que ele liberar o recurso, a chave abaixo liga o menu para a sua organização.",
                )}
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <Switch
                id="menu_enabled"
                checked={enabled}
                disabled={chavePresa || estado === "aguardando" || !podeMexer}
                onCheckedChange={(v) => alternar(v)}
              />
              <Label htmlFor="menu_enabled" className="text-sm">
                {t("Ligar o menu de texto para esta organização")}
              </Label>
            </div>
          </>
        )}
      </section>

      {/* ── 2. Link público da agenda (/a/<slug>) — só quando o slug existe ─ */}
      {props.slug !== null && props.erroConfiguracao === null ? (
        <section className="space-y-1" data-testid="link-publico-agenda">
          <h2 className="text-base font-semibold">{t("Link público da agenda")}</h2>
          <code className="rounded-md bg-muted px-2 py-1 text-sm">{`/a/${props.slug}`}</code>
          <p className="text-xs text-muted-foreground">
            {t(
              "Em breve: a página pública de agendamento ainda está em construção — este é o endereço que o cliente vai abrir.",
            )}
          </p>
        </section>
      ) : null}

      {/* ── 3. Lista de itens: adicionar / editar / renumerar / remover ───── */}
      <section className="space-y-3" data-testid="bloco-itens">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{t("Opções do menu")}</h2>
          {podeMexer ? (
            <Button
              size="sm"
              variant="outline"
              onClick={abrirNovo}
              disabled={rascunho !== null}
              data-testid="adicionar-item"
            >
              {t("Adicionar item")}
            </Button>
          ) : null}
        </div>

        {props.erroItens !== null ? (
          <div
            role="alert"
            data-testid="erro-de-leitura-itens"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            {t("Não foi possível ler os itens do menu. Recarregue a página e tente de novo.")}
          </div>
        ) : (
          <>
            <ol className="space-y-2" data-testid="lista-de-itens">
              {itens.map((item, indice) => (
                <li
                  key={item.id}
                  data-testid={`item-${item.id}`}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate text-sm font-medium">
                      <span className="text-muted-foreground">{`${item.ordem} — `}</span>
                      {item.rotulo}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.tipo === "texto" ? t("Texto fixo") : t("Consulta")}
                    </p>
                  </div>
                  {podeMexer ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("Subir")}
                        disabled={ocupado || indice === 0}
                        onClick={() => mover(indice, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("Descer")}
                        disabled={ocupado || indice === itens.length - 1}
                        onClick={() => mover(indice, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={ocupado || (rascunho !== null && rascunho.id !== item.id)}
                        onClick={() => abrirEdicao(item)}
                      >
                        {t("Editar")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={ocupado}
                        onClick={() => remover(item.id)}
                        data-testid={`remover-${item.id}`}
                      >
                        {t("Remover")}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>

            {itens.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="lista-vazia">
                {t("Nenhum item no menu ainda.")}
              </p>
            ) : null}

            {rascunho !== null ? (
              <div className="space-y-3 rounded-md border p-3" data-testid="form-item">
                <div className="grid grid-cols-[6rem_1fr] gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="item-ordem" className="text-sm">
                      {t("Ordem")}
                    </Label>
                    <Input
                      id="item-ordem"
                      data-testid="item-ordem"
                      type="number"
                      min={0}
                      value={rascunho.ordem}
                      onChange={(e) => setRascunho({ ...rascunho, ordem: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="item-rotulo" className="text-sm">
                      {t("Texto da opção")}
                    </Label>
                    <Input
                      id="item-rotulo"
                      data-testid="item-rotulo"
                      value={rascunho.rotulo}
                      onChange={(e) => setRascunho({ ...rascunho, rotulo: e.target.value })}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="item-tipo" className="text-sm">
                    {t("Tipo")}
                  </Label>
                  <select
                    id="item-tipo"
                    data-testid="item-tipo"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                    value={rascunho.tipo}
                    onChange={(e) =>
                      setRascunho({
                        ...rascunho,
                        tipo: e.target.value === "consulta" ? "consulta" : "texto",
                      })
                    }
                  >
                    <option value="texto">{t("Texto (a equipe escreve a resposta)")}</option>
                    <option value="consulta">{t("Consulta (o sistema responde na hora)")}</option>
                  </select>
                </div>

                {rascunho.tipo === "texto" ? (
                  <div className="space-y-1">
                    <Label htmlFor="item-resposta" className="text-sm">
                      {t("Resposta que o cliente recebe")}
                    </Label>
                    <Textarea
                      id="item-resposta"
                      data-testid="item-resposta"
                      rows={3}
                      value={rascunho.resposta_texto}
                      onChange={(e) => setRascunho({ ...rascunho, resposta_texto: e.target.value })}
                    />
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label htmlFor="item-consulta" className="text-sm">
                      {t("O que consultar")}
                    </Label>
                    <select
                      id="item-consulta"
                      data-testid="item-consulta"
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      value={rascunho.consulta}
                      onChange={(e) => setRascunho({ ...rascunho, consulta: e.target.value })}
                    >
                      {CONSULTAS.map((c) => (
                        <option key={c.valor} value={c.valor}>
                          {t(c.rotulo)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {erroForm !== null ? (
                  <p role="alert" data-testid="erro-form" className="text-sm text-destructive">
                    {erroForm}
                  </p>
                ) : null}

                <div className="flex gap-2">
                  <Button size="sm" onClick={salvar} disabled={ocupado} data-testid="salvar-item">
                    {ocupado ? t("Salvando…") : t("Salvar")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRascunho(null);
                      setErroForm(null);
                    }}
                    data-testid="cancelar-item"
                  >
                    {t("Cancelar")}
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* ── 4. Pré-visualização — o MESMO texto que a máquina manda ──────── */}
      <section className="space-y-2" data-testid="bloco-previsao">
        <h2 className="text-base font-semibold">{t("Pré-visualização")}</h2>
        {props.erroItens !== null ? (
          <p className="text-sm text-muted-foreground">
            {t("Sem leitura não há pré-visualização — a lista acima diz o que houve.")}
          </p>
        ) : (
          <>
            <pre className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
              {montarMenu(itens)}
            </pre>
            <p className="text-xs text-muted-foreground">
              {itens.length === 0
                ? t("Sem itens, o cliente recebe o cardápio padrão.")
                : t("É exatamente a mensagem que o cliente recebe no WhatsApp.")}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
