import { afterAll, beforeEach, expect, it, vi } from "vitest";

import type * as SocialClient from "@/lib/channels/social/client";

/**
 * O ADAPTER SOCIAL E A PROMESSA DE FALLBACK DO ENV (gap 8).
 *
 * A spec (`docs/specs/redes-sociais-nativas.md`) promete: a chave da sessão
 * (`channel_sessions.zernio_token_encrypted`) com o ENV COMO FALLBACK. O irmão
 * `zernioAdapter` já resolve credencial com `resolveZernioCreds` (sessão
 * primeiro, env depois) em TODOS os pontos dele — e o social usava
 * `zernioCredsForAccountId` direto: sem chave gravada, o envio morria com
 * "Reconecte esta conta" mesmo com o `.env` configurado.
 *
 * O que estes casos provam:
 *   1. sem chave na conta e com env → o envio SAI pelo env;
 *   2. com chave na conta e env presente → a chave da SESSÃO vence (o env
 *      nunca sobrescreve chave gravada — a ordem é o teste, não o detalhe);
 *   3. sem chave e sem env → o erro EXISTENTE, copy intocada;
 *   4/5. saúde e mídia seguem a MESMA resolução — senão a saúde gritaria
 *      "credencial_indisponivel" num canal que envia pelo env.
 *
 * O mock fica EMBAIXO da resolução de credencial (leitura da sessão no
 * banco + decifra via RPC), não em `fetch`: a ordem sessão→env roda de
 * verdade, porque é ela que está sob teste.
 */

const h = vi.hoisted(() => ({
  socialRequest: vi.fn(),
  /** Linha devolvida por QUALQUER consulta a `channel_sessions`. */
  linha: null as Record<string, unknown> | null,
  /** Plaintext devolvido pelo RPC de decifra (null = decifra indisponível). */
  decifrado: null as string | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () => ({ data: h.linha, error: null }),
      };
      return q;
    },
    rpc: async () => ({ data: h.decifrado, error: null }),
  }),
}));

vi.mock("@/lib/channels/social/client", async (original) => ({
  ...(await original<typeof SocialClient>()),
  socialRequest: h.socialRequest,
}));

// A guarda de IP resolve DNS de verdade — rede dentro de teste é sorte, não
// determinismo. Só a MÍDIA passa por aqui; os guards de URL continuam reais.
vi.mock("@/lib/automation/outbound-ip", () => ({
  assertDestinoResolvidoSeguro: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { socialAdapter } from "./adapter";

const ORG = "00000000-0000-4000-8000-000000000804";
const ENVELOPE = {
  organizationId: ORG,
  sessionRef: "acc1",
  to: "5511999999999",
  providerConversationId: "conv1",
  kind: "text",
  body: "olá",
} as const;

const ENV_ORIGINAL = {
  id: process.env.ZERNIO_ACCOUNT_ID,
  key: process.env.ZERNIO_API_KEY,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.linha = null;
  h.decifrado = null;
  // Cada caso decide se o env EXISTE — nunca pode vazar de um teste pro próximo.
  delete process.env.ZERNIO_ACCOUNT_ID;
  delete process.env.ZERNIO_API_KEY;
});

afterAll(() => {
  if (ENV_ORIGINAL.id === undefined) delete process.env.ZERNIO_ACCOUNT_ID;
  else process.env.ZERNIO_ACCOUNT_ID = ENV_ORIGINAL.id;
  if (ENV_ORIGINAL.key === undefined) delete process.env.ZERNIO_API_KEY;
  else process.env.ZERNIO_API_KEY = ENV_ORIGINAL.key;
});

it("sem chave na conta e com env: envio usa o env", async () => {
  process.env.ZERNIO_ACCOUNT_ID = "acc1";
  process.env.ZERNIO_API_KEY = "sk_env";
  h.socialRequest.mockResolvedValue({ data: { messageId: "wamid.TEST" } });

  await socialAdapter.send(ENVELOPE);

  expect(h.socialRequest).toHaveBeenCalledWith(
    "sk_env",
    "inbox/conversations/conv1/messages",
    expect.objectContaining({ accountId: "acc1", message: "olá" }),
  );
});

it("com chave na conta e env presente: usa a chave da conta (env ignorado)", async () => {
  h.linha = { zernio_account_id: "acc1", zernio_token_encrypted: "deadbeef" };
  h.decifrado = "sk_sessao";
  process.env.ZERNIO_ACCOUNT_ID = "acc1";
  process.env.ZERNIO_API_KEY = "sk_env";
  h.socialRequest.mockResolvedValue({ data: { messageId: "wamid.TEST" } });

  await socialAdapter.send(ENVELOPE);

  // A SESSÃO primeiro: o env presente não tem efeito enquanto houver chave
  // gravada — inverter a ordem faria este teste falhar com "sk_env".
  expect(h.socialRequest.mock.calls.map((chamada) => chamada[0])).toEqual(["sk_sessao"]);
});

it("sem chave e sem env: erro 'Reconecte esta conta em Redes sociais.'", async () => {
  await expect(socialAdapter.send(ENVELOPE)).rejects.toThrow(
    "Reconecte esta conta em Redes sociais.",
  );
  expect(h.socialRequest).not.toHaveBeenCalled();
});

it("saude sem chave na conta e com env: a sonda usa o env", async () => {
  // A MESMA linha serve as DUAS consultas do checkHealth: a de metadata (guarda
  // do webhook) e a de credencial — esta sem token, que é o caso do fallback.
  h.linha = { metadata: { social_webhook_id: "wh1" }, zernio_account_id: "acc1" };
  process.env.ZERNIO_ACCOUNT_ID = "acc1";
  process.env.ZERNIO_API_KEY = "sk_env";
  h.socialRequest.mockResolvedValue({ status: "healthy" });

  const saude = await socialAdapter.checkHealth!({ organizationId: ORG, sessionRef: "acc1" });

  expect(h.socialRequest).toHaveBeenCalledWith("sk_env", "accounts/acc1/health");
  expect(saude).toMatchObject({ reachable: true, status: "WORKING" });
});

it("midia sem chave na conta e com env: baixa com o env", async () => {
  process.env.ZERNIO_ACCOUNT_ID = "acc1";
  process.env.ZERNIO_API_KEY = "sk_env";
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "image/jpeg" }),
    body: {
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
        releaseLock: () => {},
        cancel: async () => {},
      }),
    },
  });

  const midia = await socialAdapter.fetchInboundMedia!({
    organizationId: ORG,
    sessionRef: "acc1",
    url: "https://zernio.com/api/v1/media/abc",
  });

  const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { headers?: Record<string, string> };
  expect(init.headers).toMatchObject({ Authorization: "Bearer sk_env" });
  expect(midia.mime).toBe("image/jpeg");
});
