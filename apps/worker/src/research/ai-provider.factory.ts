import type { AIProvider } from "@trading-copilot/ai-provider";
import { MockAIProvider } from "@trading-copilot/ai-provider";

/**
 * MOCK is the default whenever ANTHROPIC_API_KEY is unset, see
 * docs/ai-research.md "Provider selection". AnthropicAIProvider (Task 9)
 * plugs into this same factory once it exists; until Task 9 lands, setting
 * ANTHROPIC_API_KEY has no effect and the factory still returns
 * MockAIProvider (this file is re-modified in Task 9's Step 3).
 */
export function createAIProviderFromEnv(): AIProvider {
  return new MockAIProvider();
}
