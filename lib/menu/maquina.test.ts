import { describe, expect, it } from "vitest";

import {
  type ItemDoMenu,
  formatarDia,
  formatarPreco,
  proximoPasso,
  type ServicoDoMenu,
} from "./maquina";

/**
 * Máquina de estados pura do menu de texto (spec §6.1 + P5 + G1 + G4).
 *
 * Cada caso mede UM passo da transição nomeada — a entrada é o estado de
 * partida, a saída é o contrato que a Task 5 (ação `menu_responder`) consome:
 * `resposta` pronta para o envio, `estado` para `menu_sessoes`, `dados` para o
 * passo seguinte e `agendamento` só no fim da fila serviço → dia → horário.
 *
 * Sem I/O, sem relógio: as datas e as listas vêm no contexto — determinismo é
 * regra da casa, e é por isso que os dias do fixture têm data FIXA (sáb
 * 07/11/2026 em diante) em vez de "amanhã".
 */

const SERVICOS: ServicoDoMenu[] = [
  { event_type_id: "et-corte", nome: "Corte", duracao_min: 30, preco_cents: 5000 },
  { event_type_id: "et-escova", nome: "Escova", duracao_min: 20, preco_cents: 3000 },
];

/** 07/11/2026 = sábado (dia conhecido, sem relógio) — sáb, dom, seg … */
const BASE_DIAS = [
  "2026-11-07",
  "2026-11-08",
  "2026-11-09",
  "2026-11-10",
  "2026-11-11",
  "2026-11-12",
  "2026-11-13",
] as const;

function dias(quantidade: number): Array<{ data: string; rotulo: string }> {
  return [...BASE_DIAS].slice(0, quantidade).map((data) => ({ data, rotulo: formatarDia(data) }));
}

const DOZE_HORARIOS = [
  "08:00",
  "08:30",
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "13:00",
  "13:30",
  "14:00",
  "14:30",
];

/** O contexto que a Task 5 monta; cada caso só sobrescreve o que mede. */
interface ContextoDeTeste {
  servicos: ServicoDoMenu[];
  diasComVaga: Array<{ data: string; rotulo: string }>;
  horariosDoDia: string[];
  linkAgenda?: string;
  itens?: ItemDoMenu[];
}

function contexto(parcial: Partial<ContextoDeTeste> = {}): ContextoDeTeste {
  return {
    servicos: SERVICOS,
    diasComVaga: dias(7),
    horariosDoDia: ["09:00", "09:30", "10:00"],
    ...parcial,
  };
}

const MENU = [
  "Olá! Pra eu te ajudar mais rápido, responda com o número:",
  "1 — Horários de hoje",
  "2 — Preços dos serviços",
  "3 — Marcar horário",
  "0 — Falar com alguém",
].join("\n");

const FALAR_COM_ALGUEM =
  "Certo! Sua mensagem já está com a nossa equipe — alguém te responde por aqui.";

describe("proximoPasso — máquina de estados pura do menu", () => {
  it("idle com qualquer texto mostra o menu com os 4 itens", () => {
    // G1: sempre responder. "3" de cima (sem nunca ter visto o menu) também
    // cai aqui — de idle, QUALQUER texto não-vazio mostra o menu primeiro.
    for (const texto of ["oi", "3", "obrigado"]) {
      const saida = proximoPasso({ estado: "idle", dados: {}, texto }, contexto());
      expect(saida.resposta, `texto "${texto}"`).toBe(MENU);
      expect(saida.estado, `texto "${texto}"`).toBe("menu");
    }
    // Os 4 itens default (G4) na ordem da spec §6.1 — um por linha, numerados.
    expect(MENU.split("\n").slice(1)).toEqual([
      "1 — Horários de hoje",
      "2 — Preços dos serviços",
      "3 — Marcar horário",
      "0 — Falar com alguém",
    ]);
  });

  it("0 responde com o texto de falar com alguem e volta a idle", () => {
    const saida = proximoPasso(
      { estado: "menu", dados: { servico_event_type_id: "et-corte" }, texto: "0" },
      contexto(),
    );
    expect(saida.resposta).toBe(FALAR_COM_ALGUEM);
    expect(saida.estado).toBe("idle");
    // Fim de linha: o estado parcial da sessão é descartado.
    expect(saida.dados).toEqual({});
    expect(saida.agendamento).toBeUndefined();
  });

  it("3 lista os servicos numerados com duracao e preco e vai para aguardando_servico", () => {
    const saida = proximoPasso({ estado: "menu", dados: {}, texto: "3" }, contexto());
    expect(saida.estado).toBe("aguardando_servico");
    expect(saida.resposta).toContain("Ótimo! Me diz o serviço (corte, escova, coloração…)");
    expect(saida.resposta).toContain("1 — Corte · 30 min · R$ 50,00");
    expect(saida.resposta).toContain("2 — Escova · 20 min · R$ 30,00");

    // A agenda online entra como SAÍDA do passo, quando existe (spec §6.1) —
    // é o que cobre a consulta `link_agenda` do schema da Task 1.
    const comLink = proximoPasso(
      { estado: "menu", dados: {}, texto: "3" },
      contexto({ linkAgenda: "https://agenda.exemplo/salao" }),
    );
    expect(comLink.resposta).toContain(
      "→ ou manda o link da agenda online: https://agenda.exemplo/salao",
    );
  });

  it("escolha de servico lista os dias com vaga com nome do dia e vai para aguardando_dia", () => {
    const saida = proximoPasso({ estado: "aguardando_servico", dados: {}, texto: "1" }, contexto());
    expect(saida.estado).toBe("aguardando_dia");
    // O teto de 5 dias (P5): sete dias no contexto, cinco na lista.
    expect(saida.resposta).toContain(`1 — ${formatarDia("2026-11-07")}`);
    expect(saida.resposta).toContain(`5 — ${formatarDia("2026-11-11")}`);
    expect(saida.resposta).not.toContain(formatarDia("2026-11-12"));
    // Rótulo com nome do dia (não a data crua).
    expect(saida.resposta).toContain("sáb 07/11");
    expect(saida.resposta).not.toContain("2026-11-07");
    // A escolha fica em `dados` para os passos seguintes.
    expect(saida.dados.servico_event_type_id).toBe("et-corte");
    expect(saida.dados.servico_nome).toBe("Corte");
  });

  it("escolha de dia lista os horarios daquele dia e vai para aguardando_horario", () => {
    const saida = proximoPasso(
      { estado: "aguardando_dia", dados: { servico_event_type_id: "et-corte" }, texto: "2" },
      contexto({ horariosDoDia: DOZE_HORARIOS }),
    );
    expect(saida.estado).toBe("aguardando_horario");
    // O teto de 10 horários (P5): doze no contexto, dez na lista.
    expect(saida.resposta).toContain("1 — 08:00");
    expect(saida.resposta).toContain("10 — 13:30");
    expect(saida.resposta).not.toContain("14:00");
    // O dia escolhido (o 2º) fica em `dados`, como ISO.
    expect(saida.dados.dia).toBe("2026-11-08");
    expect(saida.dados.servico_event_type_id).toBe("et-corte");
  });

  it("escolha de horario devolve agendamento com event_type_id e starts_at e volta a idle", () => {
    const saida = proximoPasso(
      {
        estado: "aguardando_horario",
        dados: { servico_event_type_id: "et-corte", servico_nome: "Corte", dia: "2026-11-07" },
        texto: "2",
      },
      contexto(),
    );
    expect(saida.agendamento).toEqual({
      event_type_id: "et-corte",
      // Hora de parede SEM fuso: a máquina é pura e o fuso da organização é da
      // Task 5 (instanteDe). Formato fixado aqui para o contrato.
      starts_at: "2026-11-07T09:30:00",
    });
    expect(saida.estado).toBe("idle");
    expect(saida.dados).toEqual({});
    expect(saida.resposta).toContain("Agendado!");
    expect(saida.resposta).toContain("Corte");
    expect(saida.resposta).toContain("sáb 07/11");
    expect(saida.resposta).toContain("09:30");
  });

  it("texto nao numerico no meio da maquina repete o passo com dica sem avancar", () => {
    const emServico = proximoPasso(
      { estado: "aguardando_servico", dados: {}, texto: "corte por favor" },
      contexto(),
    );
    expect(emServico.estado).toBe("aguardando_servico");
    expect(emServico.resposta).toContain("só com o número");
    expect(emServico.resposta).toContain("1 — Corte");
    expect(emServico.dados).toEqual({});

    const emDia = proximoPasso(
      { estado: "aguardando_dia", dados: { servico_event_type_id: "et-corte" }, texto: "amanhã" },
      contexto(),
    );
    expect(emDia.estado).toBe("aguardando_dia");
    expect(emDia.resposta).toContain("só com o número");
    expect(emDia.resposta).toContain(formatarDia("2026-11-07"));
    expect(emDia.dados).toEqual({ servico_event_type_id: "et-corte" });
  });

  it("numero fora do intervalo repete com aviso de opcao invalida", () => {
    // No menu: só 0–3 existem.
    const noMenu = proximoPasso({ estado: "menu", dados: {}, texto: "7" }, contexto());
    expect(noMenu.estado).toBe("menu");
    expect(noMenu.resposta).toContain("Opção inválida");
    expect(noMenu.resposta).toContain("1 — Horários de hoje");

    // No meio da máquina: dois serviços, "9" não existe.
    const emServico = proximoPasso(
      { estado: "aguardando_servico", dados: {}, texto: "9" },
      contexto(),
    );
    expect(emServico.estado).toBe("aguardando_servico");
    expect(emServico.resposta).toContain("Opção inválida");
    expect(emServico.resposta).toContain("1 — Corte");
    expect(emServico.dados).toEqual({});
  });

  it("consulta precos lista servicos com preco formatado", () => {
    const saida = proximoPasso({ estado: "menu", dados: {}, texto: "2" }, contexto());
    expect(saida.estado).toBe("menu");
    expect(saida.resposta).toContain("Corte");
    expect(saida.resposta).toContain("30 min");
    expect(saida.resposta).toContain("R$ 50,00");
    expect(saida.resposta).toContain("R$ 30,00");
    // O helper exportado, no formato do brief (`R$ 50,00`), com e sem milhar.
    expect(formatarPreco(5000)).toBe("R$ 50,00");
    expect(formatarPreco(123456)).toBe("R$ 1.234,56");
  });

  it("consulta horarios_hoje lista os horarios de hoje", () => {
    const saida = proximoPasso(
      { estado: "menu", dados: {}, texto: "1" },
      contexto({ horariosDoDia: ["09:00", "09:30"] }),
    );
    expect(saida.estado).toBe("menu");
    expect(saida.resposta).toContain("Horários de hoje");
    expect(saida.resposta).toContain("09:00");
    expect(saida.resposta).toContain("09:30");

    // G1 vale para a consulta também: sem horários, AINDA ASSIM responde —
    // nunca `null` com texto na mão.
    const semHorarios = proximoPasso(
      { estado: "menu", dados: {}, texto: "1" },
      contexto({ horariosDoDia: [] }),
    );
    expect(semHorarios.resposta).not.toBeNull();
    expect(semHorarios.estado).toBe("menu");
  });

  it("texto vazio nao responde", () => {
    // Mídia sem texto (foto, áudio) em qualquer passo: não avança, não reseta,
    // não manda nada.
    const noMenu = proximoPasso(
      { estado: "menu", dados: { dia: "2026-11-07" }, texto: "" },
      contexto(),
    );
    expect(noMenu.resposta).toBeNull();
    expect(noMenu.estado).toBe("menu");
    expect(noMenu.dados).toEqual({ dia: "2026-11-07" });

    const emServico = proximoPasso(
      { estado: "aguardando_servico", dados: {}, texto: "   " },
      contexto(),
    );
    expect(emServico.resposta).toBeNull();
    expect(emServico.estado).toBe("aguardando_servico");

    const noIdle = proximoPasso({ estado: "idle", dados: {}, texto: "" }, contexto());
    expect(noIdle.resposta).toBeNull();
    expect(noIdle.estado).toBe("idle");
  });
});

/**
 * Itens customizados vindo de `menu_itens` (ruling do controller na Task 5):
 * `contexto.itens` é OPCIONAL e só muda o passo `menu` — 3 e 0 seguem sendo
 * da máquina (precedência travada na Task 7), os outros números vão ao item
 * pela `ordem`, e SEM `itens` o cardápio é o G4 fixo de sempre (os 11 casos
 * acima provam o fallback por continuarem verdes).
 */
describe("itens customizados de menu_itens — contexto.itens", () => {
  const ITENS = [
    {
      ordem: 5,
      rotulo: "Pacote de verão",
      tipo: "texto" as const,
      resposta_texto: "O pacote sai por R$ 199,00.",
    },
    {
      ordem: 1,
      rotulo: "Horários de hoje",
      tipo: "consulta" as const,
      consulta: "horarios_hoje" as const,
    },
    {
      ordem: 2,
      rotulo: "Agenda online",
      tipo: "consulta" as const,
      consulta: "link_agenda" as const,
    },
    {
      ordem: 3,
      rotulo: "Marcar com a Ana",
      tipo: "texto" as const,
      resposta_texto: "A Ana atende às terças.",
    },
  ];

  it("com itens presentes o menu exibe os rotulos customizados na ordem deles", () => {
    const saida = proximoPasso(
      { estado: "idle", dados: {}, texto: "oi" },
      contexto({ itens: ITENS }),
    );
    expect(saida.estado).toBe("menu");
    const linhas = (saida.resposta ?? "").split("\n");
    expect(linhas[0]).toBe("Olá! Pra eu te ajudar mais rápido, responda com o número:");
    // Ordem CRESCENTE independente da ordem do array, e o rótulo é o do BANCO.
    expect(linhas.slice(1)).toEqual([
      "1 — Horários de hoje",
      "2 — Agenda online",
      "3 — Marcar com a Ana",
      "5 — Pacote de verão",
    ]);
    // O G4 fixo não aparece onde o dono já definir o cardápio.
    expect(saida.resposta).not.toContain("0 — Falar com alguém");
    expect(saida.resposta).not.toContain("Preços dos serviços");
  });

  it("item customizado respondido pelo numero; 3 e 0 continuam sendo da maquina", () => {
    // Texto do item: a resposta é a que o dono escreveu.
    const texto = proximoPasso(
      { estado: "menu", dados: {}, texto: "5" },
      contexto({ itens: ITENS }),
    );
    expect(texto.resposta).toBe("O pacote sai por R$ 199,00.");
    expect(texto.estado).toBe("menu");

    // Precedência: a tecla 3 é da MÁQUINA mesmo com item de ordem 3 no banco.
    const tres = proximoPasso(
      { estado: "menu", dados: {}, texto: "3" },
      contexto({ itens: ITENS }),
    );
    expect(tres.estado).toBe("aguardando_servico");
    expect(tres.resposta).not.toContain("Marcar com a Ana");

    // E a tecla 0 também: o item não existe nem seria alcançado.
    const zero = proximoPasso(
      { estado: "menu", dados: {}, texto: "0" },
      contexto({ itens: ITENS }),
    );
    expect(zero.resposta).toBe(FALAR_COM_ALGUEM);
    expect(zero.estado).toBe("idle");

    // `consulta` do item vai para os handlers da máquina: horarios_hoje…
    const um = proximoPasso(
      { estado: "menu", dados: {}, texto: "1" },
      contexto({ itens: ITENS, horariosDoDia: ["09:00", "09:30"] }),
    );
    expect(um.resposta).toContain("Horários de hoje");
    expect(um.resposta).toContain("09:00");

    // …e link_agenda manda o link quando existe (e diz que não existe quando não).
    const comLink = proximoPasso(
      { estado: "menu", dados: {}, texto: "2" },
      contexto({ itens: ITENS, linkAgenda: "https://agenda.exemplo/salao" }),
    );
    expect(comLink.resposta).toContain(
      "→ ou manda o link da agenda online: https://agenda.exemplo/salao",
    );
    const semLink = proximoPasso(
      { estado: "menu", dados: {}, texto: "2" },
      contexto({ itens: ITENS }),
    );
    expect(semLink.resposta).toContain("ainda não está disponível");

    // Número sem item correspondente é opção inválida (o "else" do ruling) —
    // o cardápio exibido na repetição é o do BANCO, não o G4.
    const invalido = proximoPasso(
      { estado: "menu", dados: {}, texto: "7" },
      contexto({ itens: ITENS }),
    );
    expect(invalido.resposta).toContain("Opção inválida");
    expect(invalido.resposta).toContain("5 — Pacote de verão");
    expect(invalido.resposta).not.toContain("0 — Falar com alguém");
  });

  it("sem itens o menu cai no padrao G4 (fallback)", () => {
    // Ausente…
    const semItens = proximoPasso({ estado: "idle", dados: {}, texto: "oi" }, contexto());
    expect(semItens.resposta).toBe(MENU);
    // …e vazio: cardápio sem linha nenhuma não é cardápio — o G4 é o piso.
    const vazio = proximoPasso({ estado: "idle", dados: {}, texto: "oi" }, contexto({ itens: [] }));
    expect(vazio.resposta).toBe(MENU);

    // E os handlers fixos continuam vivos no caminho sem itens.
    const um = proximoPasso(
      { estado: "menu", dados: {}, texto: "1" },
      contexto({ horariosDoDia: ["10:00"] }),
    );
    expect(um.resposta).toContain("Horários de hoje");
    expect(um.resposta).toContain("10:00");
  });
});
