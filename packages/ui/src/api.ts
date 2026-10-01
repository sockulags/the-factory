import type {
  AgentDto,
  CardDetailDto,
  CardDto,
  DesktopBridge,
  GateDecision,
  PluginConfigDto,
  PluginDto,
  ProductDto,
  RepoDto,
  ThreadDetailDto,
  ThreadSummaryDto,
  TurnMode,
  UsageReportDto,
  WorkflowDto,
} from "@factory/protocol";

/** Typed wrapper over the desktop bridge's authenticated requests. */
export function createApi(bridge: DesktopBridge) {
  const get = <T>(path: string) => bridge.request<T>("GET", path);
  const post = <T>(path: string, body?: unknown) => bridge.request<T>("POST", path, body ?? {});
  return {
    agents: () => get<AgentDto[]>("/agents"),
    workflows: () => get<WorkflowDto[]>("/workflows"),
    products: () => get<ProductDto[]>("/products"),
    createProduct: (key: string, name: string) => post<ProductDto>("/products", { key, name }),
    repos: (productId: string) => get<RepoDto[]>(`/products/${productId}/repos`),
    addRepo: (
      productId: string,
      repo: { name: string; path: string; defaultBranch?: string; checks: string[] },
    ) => post<RepoDto>(`/products/${productId}/repos`, repo),
    plugins: () => get<PluginDto[]>("/plugins"),
    pluginConfigs: (productId: string) => get<PluginConfigDto[]>(`/products/${productId}/plugins`),
    configurePlugin: (
      productId: string,
      plugin: string,
      enabled: boolean,
      config: Record<string, unknown>,
    ) =>
      bridge.request<PluginConfigDto>("PUT", `/products/${productId}/plugins/${plugin}`, {
        enabled,
        config,
      }),
    usage: (productId: string | null, days: number) =>
      get<UsageReportDto>(`/usage?days=${days}${productId ? `&productId=${productId}` : ""}`),
    cards: (productId: string) => get<CardDto[]>(`/products/${productId}/cards`),
    createCard: (productId: string, card: { type: string; title: string; body: string }) =>
      post<CardDto>(`/products/${productId}/cards`, card),
    card: (id: string) => get<CardDetailDto>(`/cards/${id}`),
    updateCard: (id: string, patch: { title?: string; body?: string; rank?: string }) =>
      bridge.request<CardDto>("PATCH", `/cards/${id}`, patch),
    start: (id: string) => post(`/cards/${id}/start`),
    decide: (
      id: string,
      decision: GateDecision,
      comment?: string,
      opts: { discardDocs?: boolean } = {},
    ) => post(`/cards/${id}/decide`, { decision, comment, ...opts }),
    retry: (id: string) => post(`/cards/${id}/retry`),
    move: (id: string, step: string) => post(`/cards/${id}/move`, { step }),
    close: (id: string) => post(`/cards/${id}/close`),
    createThread: (cardId: string, title: string) =>
      post<ThreadSummaryDto>(`/cards/${cardId}/threads`, { title }),
    thread: (id: string) => get<ThreadDetailDto>(`/threads/${id}`),
    send: (threadId: string, agentId: string, text: string, mode: TurnMode) =>
      post(`/threads/${threadId}/messages`, { agentId, text, mode }),
    cancel: (threadId: string) => post(`/threads/${threadId}/cancel`),
  };
}

export type Api = ReturnType<typeof createApi>;
