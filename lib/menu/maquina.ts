/**
 * A máquina de estados PURA do menu de texto no WhatsApp (spec §6.1 + P5 + G1
 * + G4). Nada aqui fala com banco, rede ou relógio: entrada + contexto entram,
 * resposta + estado + dados saem — a ação `menu_responder` (Task 5) é quem
 * lê/escreve `menu_sessoes`, monta o contexto e envia o texto.
 *
 * ─── Os estados ─────────────────────────────────────────────────────────────
 *
 *   idle → (qualquer texto não-vazio) → menu → "3" → aguardando_servico →
 *   aguardando_dia → aguardando_horario → (agendamento + confirmação) → idle
 *
 *   `idle` + qualquer texto mostra o menu (G1: SEMPRE responder — call de
 *   produto registrada; se um dia quiser gatilho por palavra, é 1 linha aqui).
 *   Em `menu`: 1 = horários de hoje, 2 = preços, 3 = máquina de agendamento
 *   (P5), 0 = falar com alguém. As teclas 3 e 0 são da MÁQUINA — precedência
 *   sobre qualquer item de `menu_itens` (decisão travada na Task 7), e este
 *   módulo nem recebe itens: o cardápio fixo é o G4.
 *
 * ─── Regras que este arquivo inteiro honra ──────────────────────────────────
 *
 * - Texto vazio (só mídia) em QUALQUER estado → `resposta: null`, estado e
 *   dados intactos: não avança, não reseta, não manda nada.
 * - Não-numérico no meio da máquina → repete o passo ATUAL com dica.
 * - Número fora do intervalo → repete o passo com aviso "Opção inválida".
 * - Listas: no máximo 5 dias e 10 horários por passo (teto da P5).
 * - Consultas (`horarios_hoje`, `precos`) e o link da agenda online saem no
 *   mesmo formato de texto puro — anti-goal A1: NUNCA botão interativo.
 *
 * ─── O contrato dos `dados` (lido e gravado pela Task 5) ────────────────────
 *
 * - `servico_event_type_id` + `servico_nome` — gravados na escolha do serviço;
 * - `dia` — a data ISO ("2026-11-07") escolhida, gravada na escolha do dia;
 * - no fim (ou em `0`) os dados são ESVAZIADOS: a sessão recomeça limpa.
 *
 * `agendamento.starts_at` sai como HORA DE PAREDE SEM FUSO
 * ("2026-11-07T09:30:00"): a máquina não conhece o fuso da organização (não
 * há data global nem contexto de fuso aqui) — quem converte é a Task 5, com
 * `instanteDe` (`lib/agenda/fuso.ts`).
 */

/** O estado da sessão do contato (`menu_sessoes.estado` — vocabulário da Task 1). */
export type Estado =
  "idle" | "menu" | "aguardando_servico" | "aguardando_dia" | "aguardando_horario";

export interface Entrada {
  estado: Estado;
  dados: Record<string, unknown>;
  texto: string;
}

export interface ServicoDoMenu {
  event_type_id: string;
  nome: string;
  duracao_min: number;
  preco_cents: number | null;
}

export interface SaidaDaMaquina {
  resposta: string | null;
  estado: Estado;
  dados: Record<string, unknown>;
  /** Preenchido só no passo final (escolha de horário). */
  agendamento?: { event_type_id: string; starts_at: string };
}

const TEXTO_MENU = [
  "Olá! Pra eu te ajudar mais rápido, responda com o número:",
  "1 — Horários de hoje",
  "2 — Preços dos serviços",
  "3 — Marcar horário",
  "0 — Falar com alguém",
].join("\n");

const TEXTO_FALAR_COM_ALGUEM =
  "Certo! Sua mensagem já está com a nossa equipe — alguém te responde por aqui.";

const DICA = "Não entendi — responda só com o número de uma das opções:";
const AVISO = "Opção inválida — responda com o número de uma das opções:";

const SEM_SERVICOS =
  "Não encontrei serviços disponíveis. Fale com a equipe para saber o que oferecemos.";
const SEM_DIAS = "Não encontrei dias com vaga na agenda. Escolha outro serviço:";
const SEM_HORARIOS = "Não encontrei horários livres nesse dia. Escolha outro dia:";
const SEM_HORARIOS_HOJE = "Não encontrei horários livres para hoje.";

/** Tetos da P5 — a lista longa vira mensagem longa, e mensagem longa cansa. */
const MAX_DIAS = 5;
const MAX_HORARIOS = 10;

/**
 * `5000` → `"R$ 50,00"` — helper LOCAL e exportado, como o contrato da Task 3
 * pede. É à mão e não por `toLocaleString`: o `Intl` do ICU separa `R$` do
 * valor com espaço NÃO-QUEBRADO (U+00A0/U+202F) conforme os dados de locale
 * compilados no runtime — a mesma armadilha que `lib/tempo/agora.ts` registra
 * para o dia da semana (Node small-icu muda a saída sem lançar), e aqui o
 * texto iria para o WhatsApp do cliente. Formato fixo: `R$ 1.234,56`.
 */
export function formatarPreco(precoCents: number): string {
  const negativo = precoCents < 0;
  const absoluto = Math.abs(Math.trunc(precoCents));
  const reais = String(Math.floor(absoluto / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const centavos = String(absoluto % 100).padStart(2, "0");
  return `${negativo ? "-" : ""}R$ ${reais},${centavos}`;
}

/**
 * Nome curto do dia: `"2026-11-07"` → `"sáb 07/11"` (molde:
 * `NOME_CURTO_DO_DIA` de `lib/agent-engine/pacing/engine.ts`).
 *
 * O dia da semana é calculado da data (algoritmo de Sakamoto) e NÃO por
 * `new Date`/`Intl`: a entrada é uma string de calendário pura, o resultado é
 * determinístico em qualquer fuso/locale — e o repo já pagou a versão
 * dependente de ICU (`lib/tempo/agora.ts` explica: Node small-icu devolve
 * "friday" sem lançar). Entrada fora do formato YYYY-MM-DD volta como veio —
 * mensagem nunca quebra por data torta vinda do banco.
 */
export function formatarDia(data: string): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (partes === null) return data;
  const ano = Number(partes[1]);
  const mes = Number(partes[2]);
  const dia = Number(partes[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return data;

  // Sakamoto: domingo = 0, a mesma régua do `dow` da jornada e de `diaDaSemanaLocal`.
  const transicao = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4][mes - 1] ?? 0;
  const y = mes < 3 ? ano - 1 : ano;
  const dow =
    (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + transicao + dia) % 7;
  const curtos = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const dois = (n: number): string => String(n).padStart(2, "0");
  return `${curtos[dow] ?? ""} ${dois(dia)}/${dois(mes)}`;
}

/** "1"…"n" vira número; qualquer outra coisa vira `null` (não-numérico). */
function comoNumero(texto: string): number | null {
  return /^\d+$/.test(texto) ? Number(texto) : null;
}

function linhaDeServico(s: ServicoDoMenu, i: number): string {
  return `${i + 1} — ${s.nome} · ${s.duracao_min} min${
    s.preco_cents === null ? "" : ` · ${formatarPreco(s.preco_cents)}`
  }`;
}

function linhasDeServicos(contexto: { servicos: ServicoDoMenu[]; linkAgenda?: string }): string {
  const cabecalho = [
    "Ótimo! Me diz o serviço (corte, escova, coloração…)",
    ...contexto.servicos.map(linhaDeServico),
  ];
  if (contexto.linkAgenda != null && contexto.linkAgenda !== "") {
    cabecalho.push(`→ ou manda o link da agenda online: ${contexto.linkAgenda}`);
  }
  return cabecalho.join("\n");
}

function linhasDePrecos(servicos: ServicoDoMenu[]): string {
  return ["Preços dos serviços:", ...servicos.map(linhaDeServico)].join("\n");
}

function linhasDeDias(dias: ReadonlyArray<{ data: string; rotulo: string }>): string {
  const visiveis = dias.slice(0, MAX_DIAS);
  return ["Perfeito! Escolha o dia:", ...visiveis.map((d, i) => `${i + 1} — ${d.rotulo}`)].join(
    "\n",
  );
}

function linhasDeHorarios(horarios: readonly string[]): string {
  const visiveis = horarios.slice(0, MAX_HORARIOS);
  return ["Ótimo! Escolha o horário:", ...visiveis.map((h, i) => `${i + 1} — ${h}`)].join("\n");
}

/**
 * Um passo que não avança: repete o que o cliente já estava vendo, com DICA
 * (não-numérico) ou com AVISO (número fora do intervalo).
 */
function repetePasso(
  motivo: string,
  listagem: string,
  estado: Estado,
  dados: Record<string, unknown>,
): SaidaDaMaquina {
  return { resposta: `${motivo}\n\n${listagem}`, estado, dados };
}

/**
 * O coração puro: uma entrada de estado + texto, uma saída.
 *
 * A ordem interna é fixa e proposital: vazio primeiro (mídia não joga a
 * máquina para lugar nenhum), depois o estado, e dentro dele o número É
 * validado ANTES de virar escolha — é o que torna "repete o passo" a regra
 * em vez da exceção.
 */
export function proximoPasso(
  entrada: Entrada,
  contexto: {
    servicos: ServicoDoMenu[];
    diasComVaga: { data: string; rotulo: string }[];
    horariosDoDia: string[];
    linkAgenda?: string;
  },
): SaidaDaMaquina {
  const texto = entrada.texto.trim();

  // Mídia sem texto: não responde, não avança, não reseta (G1 pondera com a
  // realidade do WhatsApp — foto e áudio não são menu).
  if (texto === "") {
    return { resposta: null, estado: entrada.estado, dados: entrada.dados };
  }

  // G1: de idle, qualquer texto não-vazio mostra o menu — inclusive "3" e "0"
  // vindos do nada: o cliente vê o cardápio antes de qualquer atalho.
  if (entrada.estado === "idle") {
    return { resposta: TEXTO_MENU, estado: "menu", dados: entrada.dados };
  }

  if (entrada.estado === "menu") {
    // As teclas da máquina têm precedência (decisão travada da Task 7): 3 e 0
    // são respondidos AQUI, nunca por item de `menu_itens`.
    const n = comoNumero(texto);
    if (n === 0) {
      return { resposta: TEXTO_FALAR_COM_ALGUEM, estado: "idle", dados: {} };
    }
    if (n === 1) {
      const hoje = contexto.horariosDoDia;
      return {
        resposta: hoje.length === 0 ? SEM_HORARIOS_HOJE : ["Horários de hoje:", ...hoje].join("\n"),
        estado: "menu",
        dados: entrada.dados,
      };
    }
    if (n === 2) {
      return {
        resposta: contexto.servicos.length === 0 ? SEM_SERVICOS : linhasDePrecos(contexto.servicos),
        estado: "menu",
        dados: entrada.dados,
      };
    }
    if (n === 3) {
      if (contexto.servicos.length === 0) {
        return { resposta: SEM_SERVICOS, estado: "menu", dados: entrada.dados };
      }
      return {
        resposta: linhasDeServicos(contexto),
        estado: "aguardando_servico",
        dados: entrada.dados,
      };
    }
    if (n === null) {
      return repetePasso(DICA, TEXTO_MENU, "menu", entrada.dados);
    }
    return repetePasso(AVISO, TEXTO_MENU, "menu", entrada.dados);
  }

  if (entrada.estado === "aguardando_servico") {
    const listagem = linhasDeServicos(contexto);
    const n = comoNumero(texto);
    if (n === null) {
      return repetePasso(DICA, listagem, "aguardando_servico", entrada.dados);
    }
    const escolhido = contexto.servicos[n - 1];
    if (escolhido === undefined) {
      return repetePasso(AVISO, listagem, "aguardando_servico", entrada.dados);
    }
    if (contexto.diasComVaga.length === 0) {
      // Sem vaga não há passo seguinte: repete a escolha de serviço com o
      // aviso, sem gravar a escolha (nada foi decidido de fato).
      return repetePasso(SEM_DIAS, listagem, "aguardando_servico", entrada.dados);
    }
    return {
      resposta: linhasDeDias(contexto.diasComVaga),
      estado: "aguardando_dia",
      dados: {
        ...entrada.dados,
        servico_event_type_id: escolhido.event_type_id,
        servico_nome: escolhido.nome,
      },
    };
  }

  if (entrada.estado === "aguardando_dia") {
    const listagem = linhasDeDias(contexto.diasComVaga);
    const n = comoNumero(texto);
    if (n === null) {
      return repetePasso(DICA, listagem, "aguardando_dia", entrada.dados);
    }
    const escolhido = contexto.diasComVaga[n - 1];
    if (escolhido === undefined || n > MAX_DIAS) {
      return repetePasso(AVISO, listagem, "aguardando_dia", entrada.dados);
    }
    if (contexto.horariosDoDia.length === 0) {
      return repetePasso(SEM_HORARIOS, listagem, "aguardando_dia", entrada.dados);
    }
    return {
      resposta: linhasDeHorarios(contexto.horariosDoDia),
      estado: "aguardando_horario",
      dados: { ...entrada.dados, dia: escolhido.data },
    };
  }

  if (entrada.estado === "aguardando_horario") {
    const listagem = linhasDeHorarios(contexto.horariosDoDia);
    const n = comoNumero(texto);
    if (n === null) {
      return repetePasso(DICA, listagem, "aguardando_horario", entrada.dados);
    }
    const horario = contexto.horariosDoDia[n - 1];
    if (horario === undefined || n > MAX_HORARIOS) {
      return repetePasso(AVISO, listagem, "aguardando_horario", entrada.dados);
    }

    const v = entrada.dados;
    const eventTypeId = v.servico_event_type_id;
    const nome = v.servico_nome;
    const dia = v.dia;
    if (typeof eventTypeId !== "string" || typeof nome !== "string" || typeof dia !== "string") {
      // Estado corrompido (sessão de outra versão, dados apagados): em vez de
      // devolver agendamento incompleto, recomeça com uma frase honesta.
      return {
        resposta: "Não consegui continuar o agendamento. Para recomeçar, mande 3.",
        estado: "menu",
        dados: {},
      };
    }

    return {
      resposta: `Agendado! ${nome} para ${formatarDia(dia)} às ${horario}.`,
      estado: "idle",
      dados: {},
      agendamento: { event_type_id: eventTypeId, starts_at: `${dia}T${horario}:00` },
    };
  }

  // Estado fora do vocabulário (dado torto vindo do banco): G1 manda responder
  // com o menu em vez de calar.
  return { resposta: TEXTO_MENU, estado: "menu", dados: entrada.dados };
}
