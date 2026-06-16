import type { AppConfig } from "./config.js";
import type { ModelProvider } from "./types.js";

export interface ProviderModelOption {
  provider: ModelProvider;
  id: string;
  model: string;
  serviceTier: string | null;
  displayName: string;
}

export function providerLabel(provider: ModelProvider): string {
  return provider === "xai" ? "xAI/Grok" : "OpenAI";
}

export function providerFromAlias(value: string): ModelProvider | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai" || normalized === "codex") {
    return "openai";
  }
  if (normalized === "xai" || normalized === "grok") {
    return "xai";
  }
  return null;
}

export function xaiModelOptions(config: AppConfig): ProviderModelOption[] {
  return config.xaiModels.map((model) => ({
    provider: "xai",
    id: `xai:${model}`,
    model,
    serviceTier: null,
    displayName: model,
  }));
}

export function codexProviderArgs(config: AppConfig, provider: ModelProvider): string[] {
  if (provider === "openai") {
    return ["-c", 'model_provider="openai"'];
  }

  return [
    "-c",
    `model_provider=${JSON.stringify(config.xaiProviderId)}`,
    "-c",
    `model_providers.${config.xaiProviderId}.name="xAI"`,
    "-c",
    `model_providers.${config.xaiProviderId}.base_url=${JSON.stringify(config.xaiBaseUrl)}`,
    "-c",
    `model_providers.${config.xaiProviderId}.env_key=${JSON.stringify(config.xaiApiKeyEnv)}`,
    "-c",
    `model_providers.${config.xaiProviderId}.wire_api="responses"`,
  ];
}

export function codexServiceTierArgs(serviceTier: string | null): string[] {
  return serviceTier ? ["-c", `service_tier=${JSON.stringify(serviceTier)}`] : [];
}
