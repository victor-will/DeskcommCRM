import { describe, expect, it } from "vitest";

import { formatarDia, formatarPreco, proximoPasso, type ServicoDoMenu } from "./maquina";

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
