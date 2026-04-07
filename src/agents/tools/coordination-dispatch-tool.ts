import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  extractAssistantText,
  resolveSessionToolContext,
  stripToolMessages,
} from "./sessions-helpers.js";

const COORDINATION_GROUP_TARGET = "telegram:-5016824167";
const RESULT_ROUTES = new Set(["coordinator", "group", "both"]);
const VISIBILITIES = new Set(["private", "public"]);

const CoordinationDispatchToolSchema = Type.Object({
  agentId: Type.String({ minLength: 1, maxLength: 64 }),
  task: Type.String({ minLength: 1 }),
  role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  context: Type.Optional(Type.String({ minLength: 1 })),
  mode: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  visibility: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  replyTarget: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  completionSignal: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  expectedOutput: Type.Optional(Type.String({ minLength: 1 })),
  noPrivateReply: Type.Optional(Type.Boolean()),
  resultRoute: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  coordinationId: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

type GatewayCaller = typeof callGateway;

type SessionListEntry = {
  key?: string;
  status?: string;
};

function normalizeReply(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "NO_REPLY") {
    return undefined;
  }
  return trimmed;
}

async function fetchCoordinationHistoryReply(
  gatewayCall: GatewayCaller,
  sessionKey: string,
): Promise<string | undefined> {
  const history = await gatewayCall<{ messages?: Array<unknown> }>({
    method: "chat.history",
    params: { sessionKey, limit: 50 },
    timeoutMs: 10_000,
  }).catch(() => undefined);
  return normalizeReply(
    resolveLatestAssistantReply(Array.isArray(history?.messages) ? history.messages : []),
  );
}

async function fetchCoordinationSessionStatus(
  gatewayCall: GatewayCaller,
  sessionKey: string,
): Promise<string | undefined> {
  const list = await gatewayCall<{ sessions?: Array<SessionListEntry> }>({
    method: "sessions.list",
    params: { limit: 200, includeGlobal: true, includeUnknown: true },
    timeoutMs: 10_000,
  }).catch(() => undefined);
  const session = Array.isArray(list?.sessions)
    ? list.sessions.find((entry) => entry?.key === sessionKey)
    : undefined;
  return typeof session?.status === "string" ? session.status : undefined;
}

function sanitizeCoordinationId(value?: string): string {
  const trimmed = value?.trim();
  const normalized = trimmed?.replace(/[^a-zA-Z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized) {
    return normalized.slice(0, 96);
  }
  return crypto.randomUUID();
}

function buildCoordinationEnvelope(params: {
  coordinationId: string;
  mode: string;
  visibility: string;
  requesterAgentId?: string;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  delegateAgentId: string;
  role?: string;
  title?: string;
  task: string;
  context?: string;
  replyTarget?: string;
  completionSignal?: string;
  expectedOutput?: string;
  noPrivateReply: boolean;
  resultRoute: string;
}) {
  return {
    protocol: "openclaw.coordination/v1",
    coordinationId: params.coordinationId,
    mode: params.mode,
    visibility: params.visibility,
    coordinator: {
      agentId: params.requesterAgentId,
      sessionKey: params.requesterSessionKey,
      channel: params.requesterChannel,
    },
    delegate: {
      agentId: params.delegateAgentId,
      role: params.role,
    },
    replyTarget: params.replyTarget,
    resultRoute: params.resultRoute,
    completionSignal: params.completionSignal,
    noPrivateReply: params.noPrivateReply,
    task: {
      title: params.title,
      role: params.role,
      objective: params.task,
      context: params.context,
      expectedOutput: params.expectedOutput,
    },
  };
}

function buildCoordinationPrompt(envelope: ReturnType<typeof buildCoordinationEnvelope>): string {
  const envelopeJson = JSON.stringify(envelope, null, 2);
  const deliveryLines: string[] = [];
  if (
    (envelope.resultRoute === "group" || envelope.resultRoute === "both") &&
    typeof envelope.replyTarget === "string" &&
    envelope.replyTarget.trim()
  ) {
    deliveryLines.push(
      `- Use the \`message\` tool to post the visible result to \`${envelope.replyTarget}\`.`,
    );
  }
  if (envelope.resultRoute === "coordinator" || envelope.resultRoute === "both") {
    deliveryLines.push(
      "- Keep your final substantive answer in this coordination session so the coordinator can collect it upstream.",
    );
  }
  if (envelope.noPrivateReply) {
    deliveryLines.push(
      "- Do not send a separate natural-language private reply outside the protocol targets.",
    );
  }
  return [
    "Coordination session context:",
    "- This session is a dedicated A2A coordination session, not a normal chat thread.",
    "- Treat the JSON envelope below as authoritative protocol state.",
    "- Execute only the delegate task assigned to you.",
    ...deliveryLines,
    "",
    "[COORDINATION_ENVELOPE]",
    "```json",
    envelopeJson,
    "```",
  ].join("\n");
}

function resolveLatestAssistantReply(messages: unknown[]): string | undefined {
  const filtered = stripToolMessages(messages);
  for (let index = filtered.length - 1; index >= 0; index -= 1) {
    const text = extractAssistantText(filtered[index]);
    if (text) {
      return text;
    }
  }
  return undefined;
}

export function createCoordinationDispatchTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Coordination Dispatch",
    name: "coordination_dispatch",
    description:
      "Dispatch structured A2A work into a dedicated coordination session instead of a normal chat session.",
    parameters: CoordinationDispatchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callGateway;
      const delegateAgentId = normalizeAgentId(
        readStringParam(params, "agentId", { required: true }),
      );
      const task = readStringParam(params, "task", { required: true });
      const role = readStringParam(params, "role");
      const title = readStringParam(params, "title");
      const context = readStringParam(params, "context");
      const mode = readStringParam(params, "mode") ?? "dispatch";
      const requestedVisibility = readStringParam(params, "visibility")?.trim().toLowerCase();
      const visibility =
        requestedVisibility && VISIBILITIES.has(requestedVisibility)
          ? requestedVisibility
          : "private";
      const requestedReplyTarget = readStringParam(params, "replyTarget");
      const requestedResultRoute = readStringParam(params, "resultRoute")?.trim().toLowerCase();
      const resultRoute =
        requestedResultRoute && RESULT_ROUTES.has(requestedResultRoute)
          ? requestedResultRoute
          : "coordinator";
      const replyTarget =
        requestedReplyTarget ??
        (resultRoute === "group" || resultRoute === "both"
          ? COORDINATION_GROUP_TARGET
          : opts?.agentSessionKey);
      const completionSignal =
        readStringParam(params, "completionSignal") ??
        (resultRoute === "group" || resultRoute === "both"
          ? "post_once_to_reply_target"
          : "reply_in_coordination_session");
      const expectedOutput = readStringParam(params, "expectedOutput");
      const noPrivateReply =
        typeof params.noPrivateReply === "boolean"
          ? params.noPrivateReply
          : resultRoute === "group" || resultRoute === "both";
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 90;
      const timeoutMs = timeoutSeconds * 1000;
      const { cfg, effectiveRequesterKey } = resolveSessionToolContext(opts);
      const requesterAgentId = normalizeAgentId(
        resolveAgentIdFromSessionKey(effectiveRequesterKey),
      );
      const a2aPolicy = createAgentToAgentPolicy(cfg);

      if (requesterAgentId && requesterAgentId !== delegateAgentId) {
        if (!a2aPolicy.enabled) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error:
              "Agent-to-agent coordination is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent coordination.",
          });
        }
        if (!a2aPolicy.isAllowed(requesterAgentId, delegateAgentId)) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Agent-to-agent coordination denied by tools.agentToAgent.allow.",
          });
        }
      }

      const coordinationId = sanitizeCoordinationId(readStringParam(params, "coordinationId"));
      const sessionKey = `agent:${delegateAgentId}:coord:${coordinationId}`;
      const runId = crypto.randomUUID();
      if ((resultRoute === "group" || resultRoute === "both") && !replyTarget) {
        return jsonResult({
          runId,
          status: "error",
          error: "coordination_dispatch requires replyTarget when resultRoute is group or both.",
        });
      }
      const envelope = buildCoordinationEnvelope({
        coordinationId,
        mode,
        visibility,
        requesterAgentId,
        requesterSessionKey: opts?.agentSessionKey,
        requesterChannel: opts?.agentChannel,
        delegateAgentId,
        role,
        title,
        task,
        context,
        replyTarget,
        completionSignal,
        expectedOutput,
        noPrivateReply,
        resultRoute,
      });
      const message = ["[COORDINATION_TASK]", JSON.stringify(envelope, null, 2)].join("\n");
      const extraSystemPrompt = buildCoordinationPrompt(envelope);

      try {
        const start = await gatewayCall<{ runId?: string }>({
          method: "agent",
          params: {
            message,
            sessionKey,
            idempotencyKey: runId,
            deliver: false,
            channel: INTERNAL_MESSAGE_CHANNEL,
            lane: AGENT_LANE_NESTED,
            extraSystemPrompt,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: opts?.agentSessionKey,
              sourceChannel: opts?.agentChannel,
              sourceTool: "coordination_dispatch",
            },
          },
          timeoutMs: 10_000,
        });
        const acceptedRunId = typeof start?.runId === "string" && start.runId ? start.runId : runId;
        let reply: string | undefined;
        if (timeoutSeconds > 0) {
          const wait = await gatewayCall<{ status?: string; error?: string }>({
            method: "agent.wait",
            params: { runId: acceptedRunId, timeoutMs },
            timeoutMs: timeoutMs + 2_000,
          });
          const status = typeof wait?.status === "string" ? wait.status : "ok";
          if (status === "timeout" || status === "error") {
            reply = await fetchCoordinationHistoryReply(gatewayCall, sessionKey);
            const sessionStatus =
              status === "timeout"
                ? await fetchCoordinationSessionStatus(gatewayCall, sessionKey)
                : undefined;
            const effectiveStatus =
              status === "timeout" && sessionStatus === "running"
                ? "running"
                : status === "timeout" && sessionStatus === "done"
                  ? "ok"
                  : status;
            return jsonResult({
              runId: acceptedRunId,
              status: effectiveStatus,
              error: typeof wait?.error === "string" ? wait.error : undefined,
              sessionKey,
              coordinationId,
              reply,
              delivery: {
                mode: "coordination",
                visibility,
                replyTarget,
                resultRoute,
              },
              envelope,
            });
          }
          reply = await fetchCoordinationHistoryReply(gatewayCall, sessionKey);
        }
        return jsonResult({
          runId: acceptedRunId,
          status: timeoutSeconds === 0 ? "accepted" : "ok",
          sessionKey,
          coordinationId,
          reply,
          delivery: {
            mode: "coordination",
            visibility,
            replyTarget,
            resultRoute,
          },
          envelope,
        });
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        return jsonResult({
          runId,
          status: messageText.includes("gateway timeout") ? "timeout" : "error",
          error: messageText,
          sessionKey,
          coordinationId,
        });
      }
    },
  };
}
