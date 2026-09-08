export type TokenUsage = {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: {
    readonly read: number;
    readonly write: number;
  };
};

export type UsageMessage = {
  readonly id?: string;
  readonly role: string;
  readonly tokens?: TokenUsage;
};

export type UsagePart = {
  readonly type: string;
  readonly tokens?: TokenUsage;
};

const emptyUsage = (): TokenUsage => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

export const aggregateAssistantTokenUsage = (
  messages: readonly UsageMessage[],
  partsForMessage: (messageId: string) => readonly UsagePart[] = () => [],
  fallback?: TokenUsage,
): TokenUsage | undefined => {
  const usages = messages.flatMap((message): readonly TokenUsage[] => {
    if (message.role !== "assistant") return [];
    const stepUsages = message.id
      ? partsForMessage(message.id).flatMap((part) =>
          part.type === "step-finish" && part.tokens ? [part.tokens] : [],
        )
      : [];
    if (stepUsages.length > 0) return stepUsages;
    return message.tokens ? [message.tokens] : [];
  });
  if (usages.length === 0) return fallback;

  return usages.reduce<TokenUsage>((total, usage) => {
    return {
      input: total.input + usage.input,
      output: total.output + usage.output,
      reasoning: total.reasoning + usage.reasoning,
      cache: {
        read: total.cache.read + usage.cache.read,
        write: total.cache.write + usage.cache.write,
      },
    };
  }, emptyUsage());
};
