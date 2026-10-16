import { Rpc } from "@opencode/plugin";
import { z } from "zod";

const windowPair = <Value extends z.ZodTypeAny>(value: Value) =>
  z.object({ primary: value, secondary: value });

/** Wire shape of `ProbeSnapshot`; the RPC boundary validates untrusted payloads. */
export const ProbeSnapshotSchema = z.object({
  status: z.string(),
  statusCode: z.union([z.number(), z.string()]).optional(),
  used: z.union([windowPair(z.number().nullable()), z.string()]).optional(),
  reset: z.union([windowPair(z.string().nullable()), z.string()]).optional(),
  resetAtMs: windowPair(z.number().nullable()).optional(),
  windowMinutes: z.union([windowPair(z.number().nullable()), z.string()]).optional(),
  plan: z.string().optional(),
  profile: z.string().optional(),
  probeTokens: z.number().optional(),
  error: z.string().optional(),
});

export const UsageRequestSchema = z
  .object({
    retryCount: z.number().int().min(0).max(2).optional(),
  })
  .strict();

export type UsageRequest = z.infer<typeof UsageRequestSchema>;

export const CODEX_USAGE_RPC = Rpc.define({
  id: "opencode-codex-usage",
  methods: {
    usage: {
      input: UsageRequestSchema,
      output: ProbeSnapshotSchema,
    },
    pollingEligible: {
      input: z.object({ sessionID: z.string().min(1) }).strict(),
      output: z.boolean(),
    },
  },
  events: {},
});
