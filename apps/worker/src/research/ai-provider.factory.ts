import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "@trading-copilot/ai-provider";
import { AnthropicAIProvider, MockAIProvider } from "@trading-copilot/ai-provider";

/**
 * MOCK is the default whenever ANTHROPIC_API_KEY is unset, see
 * docs/ai-research.md "Provider selection". Automated tests/CI always run
 * with ANTHROPIC_API_KEY unset, so they always exercise MockAIProvider and
 * never make a real network call.
 */
export function createAIProviderFromEnv(): AIProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new MockAIProvider();
  }
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
  return new AnthropicAIProvider(client, model);
}
