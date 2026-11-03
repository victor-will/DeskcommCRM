/**
 * Descoberta condicionada ao módulo `redes_sociais` (Addon #1, gap 2).
 *
 * Os DOIS casos do brief medem o par (aba + header) pela PÁGINA — porque o
 * header mora em `app/app/connections/page.tsx` e a aba no shell; renderizar
 * a página é o que prova que os dois leem a MESMA flag resolvida no servidor.
 *
 * Os9 filhos do shell viram marcadores: o que se mede aqui é a ESTRUTURA de
 * abas e a copy do header, não o conteúdo de cada canal (cada um tem o seu
 * próprio teste ao lado).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  aba: "",
  moduloLigado: vi.fn(),
  requireAuth: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.aba),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: h.requireAuth,
  resolveActiveOrg: h.resolveActiveOrg,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/instalacao/modulos", async (orig) => ({
  ...(await orig<typeof import("@/lib/instalacao/modulos")>()),
  moduloLigado: h.moduloLigado,
}));

vi.mock("./RedesSociaisClient", () => ({
  RedesSociaisClient: () => <div data-testid="child-sociais" />,
}));
vi.mock("./CanalGraphParceiroClient", () => ({
  CanalGraphParceiroClient: () => <div data-testid="child-graph" />,
}));
vi.mock("./CanalOficialClient", () => ({
  CanalOficialClient: () => <div data-testid="child-oficial" />,
}));
vi.mock("./CanalParceiroClient", () => ({
  CanalParceiroClient: () => <div data-testid="child-parceiro" />,
}));
vi.mock("./CanalVozClient", () => ({ CanalVozClient: () => <div data-testid="child-voz" /> }));
vi.mock("./ConnectionsClient", () => ({
  ConnectionsClient: () => <div data-testid="child-numeros" />,
}));
vi.mock("./TemplatesClient", () => ({
  TemplatesClient: () => <div data-testid="child-templates" />,
}));
vi.mock("./TemplatesParceiroClient", () => ({
  TemplatesParceiroClient: () => <div data-testid="child-templates-parceiro" />,
}));
vi.mock("./TelefoniaClient", () => ({
  TelefoniaClient: () => <div data-testid="child-telefonia" />,
}));

import ConnectionsPage from "@/app/app/connections/page";

/** A descrição de hoje — com a flag OFF o header tem de ser byte-idêntico a ela. */
const HEADER_BASE =
  "Por onde seu negócio fala com o cliente. Conecte números por QR ou o número oficial da Meta, e acompanhe a saúde de cada um.";
/** A copy nova (brief, verbatim) — acrescida SÓ com a flag ligada. */
const HEADER_EXTRAS =
  "Conecte também seu Instagram e seu Messenger — as mensagens chegam na mesma caixa de entrada.";

beforeEach(() => {
  h.aba = "";
  h.moduloLigado.mockReset();
  h.requireAuth.mockResolvedValue({
    idioma: "pt-BR",
    is_platform_admin: false,
    support: false,
  });
  h.resolveActiveOrg.mockResolvedValue({ orgId: "org-1", role: "admin" });
});

afterEach(cleanup);

describe("descoberta das Redes sociais condicionada ao módulo", () => {
  it("flag ligada: shell mostra a aba Redes sociais e o header cita Instagram/Messenger", async () => {
    h.moduloLigado.mockResolvedValue(true);

    render(await ConnectionsPage());

    expect(screen.getByRole("tab", { name: "Redes sociais" })).toBeInTheDocument();
    // O header é a base + a copy nova, na MESMA frase (append do brief).
    expect(screen.getByText(`${HEADER_BASE} ${HEADER_EXTRAS}`)).toBeInTheDocument();
  });

  it("flag desligada: shell NAO mostra a aba, e ?aba=sociais cai na aba padrao", async () => {
    h.moduloLigado.mockResolvedValue(false);
    h.aba = "sociais"; // deep link para a aba escondida

    render(await ConnectionsPage());

    expect(screen.queryByRole("tab", { name: "Redes sociais" })).toBeNull();
    // Espelho do tratamento do `graph`: a URL não escolhe o que não existe —
    // cai na aba padrão (Números por QR).
    expect(screen.getByRole("tab", { name: "Números por QR" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // E o conteúdo social nem é montado.
    expect(screen.queryByTestId("child-sociais")).toBeNull();
    // Header byte-idêntico ao de hoje: só a base, sem Instagram/Messenger.
    expect(screen.getByText(HEADER_BASE)).toBeInTheDocument();
    expect(screen.queryByText(/Instagram e seu Messenger/)).toBeNull();
  });
});
