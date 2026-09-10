export function isCodexAssistantMessage(
	message: { role?: string; provider?: string } | undefined,
): boolean {
	return message?.role === "assistant" && message.provider === "openai-codex";
}

export function shouldShowCodexUsage(input: {
	model?: { provider?: string };
	isUsingOAuth: boolean;
}): boolean {
	return input.model?.provider === "openai-codex" && input.isUsingOAuth;
}
