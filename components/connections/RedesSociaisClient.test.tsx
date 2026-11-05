import { beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RedesSociaisClient } from "./RedesSociaisClient";
import { SOCIAL_PROVIDER_LABEL } from "@/lib/channels/social/catalog";
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), remove: vi.fn(), params: "" }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: h.get, post: h.post, delete: h.remove } }));
// Query string REAL (`connected=1` etc.): `h.params` guarda a string inteira,
// como a URL faria — valor solto parseava como chave e o parâmetro nunca existia
// (a lição do fix round anterior do ConexoesShell).
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(h.params) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("./ChannelAiAccess", () => ({ ChannelAiAccess: () => <div>IA pausada</div> }));
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.params = "";
});
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RedesSociaisClient />
    </QueryClientProvider>,
  );
}
it("shows connected networks and offers inbox only where implemented", async () => {
  h.get.mockResolvedValue({
    data: {
      configured: true,
      label: "Partner",
      networks: [
        { id: "instagram", label: "Instagram" },
        { id: "linkedin", label: "LinkedIn" },
      ],
      accounts: [
        {
          id: "a",
          platform: "instagram",
          username: "brand",
          active: true,
          inbox_supported: true,
          channel: null,
        },
        {
          id: "b",
          platform: "linkedin",
          username: "person",
          active: true,
          inbox_supported: false,
          channel: null,
        },
      ],
    },
  });
  h.post.mockResolvedValue({ data: { channel_id: "c" } });
  mount();
  await screen.findByText("brand");
  expect(screen.getAllByRole("button", { name: "Receber no atendimento" })).toHaveLength(1);
  expect(h.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Receber no atendimento" }));
  await screen.findByText("person");
  expect(h.post).toHaveBeenCalledWith("/api/v1/channels/social", {
    action: "inbox",
    account_id: "a",
  });
});
it("shows errors rather than a false empty or connected state", async () => {
  h.get.mockRejectedValue(new Error("Credencial recusada"));
  mount();
  expect((await screen.findByRole("alert")).textContent).toContain("Credencial recusada");
});
it("asks before removing an account from support and keeps it linked", async () => {
  h.get.mockResolvedValue({
    data: {
      configured: true,
      label: "Partner",
      networks: [{ id: "instagram", label: "Instagram" }],
      accounts: [
        {
          id: "a",
          platform: "instagram",
          username: "brand",
          active: true,
          inbox_supported: true,
          channel: { id: "c", status: "WORKING", metadata: {} },
        },
      ],
    },
  });
  h.post.mockResolvedValue({ data: { channel_id: "c", account_removed: false } });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Remover do atendimento" }));
  expect(h.post).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Remover" }));
  await vi.waitFor(() =>
    expect(h.post).toHaveBeenCalledWith("/api/v1/channels/social", {
      action: "disconnect",
      account_id: "a",
      remove_account: false,
    }),
  );
});
it("shows orphaned channels and removes them through the disconnect action, which deletes the provider webhook", async () => {
  h.get.mockResolvedValue({
    data: {
      configured: true,
      label: "Partner",
      networks: [{ id: "instagram", label: "Instagram" }],
      accounts: [],
      orphaned_channels: [
        { channel_id: "ch-orfa", account_id: "velha", display_name: "Instagram velha", status: "FAILED" },
      ],
    },
  });
  h.post.mockResolvedValue({ data: { channel_id: "ch-orfa", account_removed: false } });
  mount();
  await screen.findByText("Canais sem conta no perfil");
  fireEvent.click(screen.getByRole("button", { name: "Excluir" }));
  fireEvent.click(await screen.findByRole("button", { name: "Excluir canal" }));
  await vi.waitFor(() =>
    expect(h.post).toHaveBeenCalledWith("/api/v1/channels/social", {
      action: "disconnect",
      account_id: "velha",
      remove_account: false,
    }),
  );
  // channel-sessions/[id] não apaga a assinatura no provedor: ela ficaria viva.
  expect(h.remove).not.toHaveBeenCalled();
});
it("asks before unlinking the profile and posts unlink on confirm", async () => {
  h.get.mockResolvedValue({
    data: {
      configured: true,
      label: "Partner",
      networks: [{ id: "instagram", label: "Instagram" }],
      accounts: [],
      orphaned_channels: [],
    },
  });
  h.post.mockResolvedValue({ data: { desvinculado: true } });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Desvincular perfil" }));
  expect(h.post).not.toHaveBeenCalled();
  await screen.findByText("Desvincular o perfil?");
  fireEvent.click(screen.getByRole("button", { name: /^Desvincular$/ }));
  await vi.waitFor(() =>
    expect(h.post).toHaveBeenCalledWith("/api/v1/channels/social", { action: "unlink" }),
  );
});
it("titles the card with the name typed in Renomear, and keeps the username when nobody renamed it", async () => {
  // A conexão nasce com `${rede} · ${usuario}`; esse nome de nascença não troca o
  // título de todo cartão que já existe — só o nome digitado à mão troca.
  const conta = (id: string, username: string, display_name: string) => ({
    id,
    platform: "instagram",
    username,
    active: true,
    inbox_supported: true,
    channel: { id: `c-${id}`, status: "WORKING", display_name, metadata: {} },
  });
  h.get.mockResolvedValue({
    data: {
      configured: true,
      label: "Partner",
      networks: [{ id: "instagram", label: "Instagram" }],
      accounts: [conta("a", "brand", "instagram · brand"), conta("b", "loja", "Loja do centro")],
    },
  });
  mount();
  expect((await screen.findByRole("heading", { name: "brand" })).tagName).toBe("H3");
  expect(screen.queryByText("instagram · brand")).toBeNull();
  expect(screen.getByRole("heading", { name: "Loja do centro" })).toBeTruthy();
  expect(screen.getByText("loja")).toBeTruthy();
});

it("ressincroniza o webhook do canal social pela origem atual, sem desconectar", async () => {
  h.get.mockResolvedValue({
    data: {
      configured: true,
      label: "Partner",
      networks: [{ id: "instagram", label: "Instagram" }],
      accounts: [
        {
          id: "a",
          platform: "instagram",
          username: "brand",
          active: true,
          inbox_supported: true,
          channel: { id: "c", status: "WORKING", metadata: {} },
        },
      ],
    },
  });
  h.post.mockResolvedValue({ data: { channel_id: "c", resynced: true } });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Ressincronizar webhook" }));
  await vi.waitFor(() =>
    expect(h.post).toHaveBeenCalledWith("/api/v1/channels/social", {
      action: "resync",
      account_id: "a",
    }),
  );
});

// ── Pós-autorização (gap 3): o próximo passo em destaque ────────────────────
// A auditoria achou que nada empurra o cliente a ATIVAR o recebimento depois
// de autorizar: o copy avisa, mas nenhum elemento aponta para a ação.

const contaRecemAutorizada = {
  configured: true,
  label: "Partner",
  networks: [{ id: "instagram", label: "Instagram" }],
  accounts: [
    {
      id: "a",
      platform: "instagram",
      username: "brand",
      active: true,
      inbox_supported: true,
      channel: null,
    },
  ],
};

it("connected=1: mostra o banner com o texto exato e destaca a acao de recebimento", async () => {
  h.params = "connected=1";
  h.get.mockResolvedValue({ data: contaRecemAutorizada });
  mount();
  await screen.findByText("brand");

  // O banner NOVO com o texto EXATO do brief — e o de hoje continua ao lado
  // (ADD-ONLY: nada existente foi substituído).
  expect(
    screen.getByText(
      "Autorização concluída! Agora ative o recebimento para que as mensagens cheguem ao atendimento.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText(/Autorização concluída\. Confira a conta na lista/)).toBeInTheDocument();

  // O destaque aponta para a ação: o cartão pulsante CONTEM o botão
  // "Receber no atendimento" — anel + animação, a linguagem visual da casa.
  const cartao = screen.getByTestId("conta-recem-conectada");
  expect(cartao.className).toContain("ring-2");
  expect(cartao.className).toContain("animate-pulse");
  expect(
    within(cartao).getByRole("button", { name: "Receber no atendimento" }),
  ).toBeInTheDocument();
});

it("sem connected=1: sem banner", async () => {
  h.get.mockResolvedValue({ data: contaRecemAutorizada });
  mount();
  await screen.findByText("brand");

  // Nenhuma das DUAS frases de sucesso (a nova e a de hoje) aparece, e o
  // cartão não ganha destaque — byte-equal ao comportamento de antes.
  expect(screen.queryByText(/Autorização concluída/)).toBeNull();
  expect(screen.queryByTestId("conta-recem-conectada")).toBeNull();
});

// ── Diagnóstico de health acionável (gap 4) ─────────────────────────────────
// A rota já devolve `can_post` e `missing_permissions` (route.ts:203-204); o
// que faltava era a TELA traduzir os sinais em instrução — hoje toda resposta
// virava a mesma frase genérica.

const contaComCanalAtivo = {
  configured: true,
  label: "Partner",
  networks: [{ id: "instagram", label: "Instagram" }],
  accounts: [
    {
      id: "a",
      platform: "instagram",
      username: "brand",
      active: true,
      inbox_supported: true,
      channel: { id: "c", status: "WORKING", display_name: null, metadata: {} },
    },
  ],
};

async function health(resposta: Record<string, unknown>): Promise<void> {
  h.get.mockResolvedValue({ data: contaComCanalAtivo });
  h.post.mockResolvedValue({ data: resposta });
  mount();
  await screen.findByText("brand");
  fireEvent.click(await screen.findByRole("button", { name: "Verificar conexão" }));
}

it("health com permissões faltando: a instrução de reconectar (mesmo com can_post false)", async () => {
  // Os DOIS sinais juntos: o mais específico (permissões faltando) vem primeiro
  // — a ação indicada é reconectar ACEITANDO tudo, e não só "pode falhar".
  await health({
    status: "healthy",
    can_post: false,
    missing_permissions: ["send_message", "manage_messages"],
  });
  expect(
    await screen.findByText(
      "Faltam permissões de mensagem nesta conta. Reconecte a conta e aceite todas as permissões solicitadas.",
    ),
  ).toBeInTheDocument();
  // A frase genérica e o diagnóstico de can_post NÃO aparecem — precedência.
  expect(screen.queryByText("A conexão precisa de atenção")).toBeNull();
  expect(
    screen.queryByText("Esta conta está sem permissão para enviar mensagens. Reconecte para corrigir."),
  ).toBeNull();
});

it("health com can_post false (sem permissões faltando): a instrução de reconectar por envio", async () => {
  await health({ status: "healthy", can_post: false, missing_permissions: [] });
  expect(
    await screen.findByText(
      "Esta conta está sem permissão para enviar mensagens. Reconecte para corrigir.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("A conexão precisa de atenção")).toBeNull();
});

it("health saudável sem sinais novos: a frase de sempre — e sem reclamar do que não falta", async () => {
  // Saudável (hoje: "Conexão verificada" — comportamento preservado, ADD-ONLY)…
  await health({ status: "healthy", can_post: true, missing_permissions: [] });
  expect(await screen.findByText("Conexão verificada")).toBeInTheDocument();
  expect(
    screen.queryByText(/Faltam permissões|sem permissão para enviar mensagens/),
  ).toBeNull();

  // …e a SEM sinais e SEM saúde: a frase genérica atual, intacta.
  await health({ status: "unhealthy", can_post: null, missing_permissions: [] });
  expect(await screen.findByText("A conexão precisa de atenção")).toBeInTheDocument();
  expect(
    screen.queryByText(/Faltam permissões|sem permissão para enviar mensagens/),
  ).toBeNull();
});

// ── Copy do provedor em linguagem de leigo (gap 5) ──────────────────────────
// O campo da chave só existe para quem ainda não configurou (ou está
// reconfigurando) — é ali que o jargão do provedor soltava sem contexto nenhum.

it("campo da chave: helper de leigo com a copy exata, logo abaixo da nota de cifra", async () => {
  h.get.mockResolvedValue({
    data: {
      configured: false,
      label: "Partner",
      networks: [{ id: "instagram", label: "Instagram" }],
      accounts: [],
    },
  });
  mount();
  const helper = await screen.findByText(
    `Normalmente esta chave vem configurada na sua implantação. Preencha só se estiver reconfigurando o provedor (${SOCIAL_PROVIDER_LABEL}).`,
  );
  // Byte-idêntico no DOM: `textContent` cru, sem o normalizador de espaços do
  // Testing Library — se a emenda do parêntese renderizar espaço a mais ou
  // menos, este teste acusa.
  expect(helper.textContent).toBe(
    `Normalmente esta chave vem configurada na sua implantação. Preencha só se estiver reconfigurando o provedor (${SOCIAL_PROVIDER_LABEL}).`,
  );
  expect(helper).toBeInTheDocument();
  // ADD-ONLY: a nota de cifra continua intacta e o helper vem DEPOIS dela.
  const cifra = screen.getByText("A chave fica cifrada no servidor e não é exibida novamente.");
  expect(cifra.compareDocumentPosition(helper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
