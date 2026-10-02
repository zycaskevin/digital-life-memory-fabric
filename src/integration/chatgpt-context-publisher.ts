import { createHash, randomUUID } from "node:crypto";

import {
  CHATGPT_CAPTURE_CONTRACT,
  type ChatGptCapturedConversation,
  type ChatGptCapturedMessage,
} from "../source-adapters/chatgpt-capture-adapter.js";
import {
  ChatGptCaptureConflictError,
  type ChatGptCaptureInboxWriteResult,
} from "./chatgpt-capture-inbox.js";

export const CHATGPT_CONTEXT_PUBLISHER_CONTRACT =
  "dlmf/chatgpt-context-publisher/v1" as const;

export const CHATGPT_CONTEXT_PUBLISHER_TRANSPORT = "context_publisher" as const;

export type ChatGptContextCompleteness =
  | "full_visible_context"
  | "partial_visible_context"
  | "unknown";

export interface ChatGptContextPublisherMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ChatGptContextPublisherInput {
  conversationId?: string;
  contextCompleteness: ChatGptContextCompleteness;
  messages: ChatGptContextPublisherMessage[];
  title?: string;
}

export interface ChatGptContextPublisherResult {
  contract: typeof CHATGPT_CONTEXT_PUBLISHER_CONTRACT;
  transport: typeof CHATGPT_CONTEXT_PUBLISHER_TRANSPORT;
  conversationId: string;
  outcome: ChatGptCaptureInboxWriteResult["outcome"];
  publishedMessageCount: number;
  contextCompleteness: ChatGptContextCompleteness;
  authoritativeTranscript: false;
  canonicalMemoryWrites: 0;
  captureInbox: {
    contract: string;
    conversationIdHash: string;
    revisionHash: string;
    updatedAt: string;
    status: ChatGptCapturedConversation["status"];
  };
}

export interface ChatGptContextPublisherOptions {
  publishSnapshot(
    snapshot: ChatGptCapturedConversation,
    expectedRevision: string | null,
  ): Promise<ChatGptCaptureInboxWriteResult & { contract?: string }>;
  readCurrentSnapshot?: (
    conversationId: string,
  ) => Promise<ChatGptCapturedConversation | undefined>;
  clock?: () => Date;
  conversationIdFactory?: () => string;
}

const MAX_MESSAGES = 512;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TOTAL_TEXT_BYTES = 768 * 1024;
const MAX_TITLE_BYTES = 1024;
const MAX_SESSION_ID_BYTES = 4096;
const MAX_CAS_ATTEMPTS = 4;
const PUBLISHER_FORMAT_VERSION = 2;
const CONTEXT_CONVERSATION_ID = /^chatgpt-context-[A-Za-z0-9._:-]{8,220}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function chatGptContextConversationIdForSession(sessionId: unknown): string {
  if (
    typeof sessionId !== "string"
    || sessionId.length === 0
    || sessionId !== sessionId.trim()
    || utf8Bytes(sessionId) > MAX_SESSION_ID_BYTES
  ) {
    throw new Error("context publisher requires valid openai/session metadata");
  }
  return `chatgpt-context-${sha256(
    `dlmf/chatgpt-openai-session/v1\0${sessionId}`,
  )}`;
}

function requireConversationId(value: string): string {
  if (
    value !== value.trim()
    || value.length === 0
    || value.length > 240
    || !CONTEXT_CONVERSATION_ID.test(value)
  ) {
    throw new Error(
      "context publisher conversationId must start with chatgpt-context- and use a bounded safe identifier",
    );
  }
  return value;
}

function requireText(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${field} must contain visible text`);
  }
  if (utf8Bytes(value) > MAX_MESSAGE_BYTES) {
    throw new Error(`${field} exceeds the per-message byte limit`);
  }
  return value;
}

function validateMessageSet(
  messages: ChatGptContextPublisherMessage[],
  label: string,
): ChatGptContextPublisherMessage[] {
  if (!Array.isArray(messages) || messages.length < 1) {
    throw new Error("context publisher requires at least one visible message");
  }
  if (messages.length > MAX_MESSAGES) {
    throw new Error(`context publisher ${label} message count exceeds the limit`);
  }

  let totalTextBytes = 0;
  return messages.map((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") {
      throw new Error(`messages[${index}].role must be user or assistant`);
    }
    const text = requireText(message.text, `messages[${index}].text`);
    totalTextBytes += utf8Bytes(text);
    if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) {
      throw new Error(`context publisher ${label} text exceeds the byte limit`);
    }
    return { role: message.role, text };
  });
}

function validateInput(input: ChatGptContextPublisherInput): ChatGptContextPublisherInput {
  if (
    input.contextCompleteness !== "full_visible_context"
    && input.contextCompleteness !== "partial_visible_context"
    && input.contextCompleteness !== "unknown"
  ) {
    throw new Error("contextCompleteness is invalid");
  }

  const messages = validateMessageSet(input.messages, "input");
  let title: string | undefined;
  if (input.title !== undefined) {
    if (input.title.trim().length === 0 || utf8Bytes(input.title) > MAX_TITLE_BYTES) {
      throw new Error("context publisher title is invalid");
    }
    title = input.title;
  }

  return {
    ...(input.conversationId === undefined
      ? {}
      : { conversationId: requireConversationId(input.conversationId) }),
    contextCompleteness: input.contextCompleteness,
    messages,
    ...(title === undefined ? {} : { title }),
  };
}

function visible(message: ChatGptCapturedMessage): ChatGptContextPublisherMessage {
  if (message.role !== "user" && message.role !== "assistant") {
    throw new Error("context publisher prior capture contains non-visible roles");
  }
  return { role: message.role, text: message.text };
}

function sameMessage(
  left: ChatGptContextPublisherMessage,
  right: ChatGptContextPublisherMessage,
): boolean {
  return left.role === right.role && left.text === right.text;
}

function sameSequence(
  left: ChatGptContextPublisherMessage[],
  right: ChatGptContextPublisherMessage[],
): boolean {
  return left.length === right.length
    && left.every((message, index) => sameMessage(message, right[index]!));
}

type MessageAlignment =
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "unique"; pairs: Array<readonly [number, number]> };

/**
 * Find an exact-message LCS and prove whether its matched pair coordinates are
 * unique. The publisher may merge around a unique ordered overlap, but it must
 * never guess between repeated-message alignments.
 */
function uniqueOrderedAlignment(
  prior: ChatGptContextPublisherMessage[],
  incoming: ChatGptContextPublisherMessage[],
): MessageAlignment {
  const rows = prior.length + 1;
  const columns = incoming.length + 1;
  const forward = Array.from(
    { length: rows },
    () => new Uint16Array(columns),
  );
  for (let i = 0; i < prior.length; i += 1) {
    for (let j = 0; j < incoming.length; j += 1) {
      forward[i + 1]![j + 1] = sameMessage(prior[i]!, incoming[j]!)
        ? forward[i]![j]! + 1
        : Math.max(forward[i]![j + 1]!, forward[i + 1]![j]!);
    }
  }

  const overlap = forward[prior.length]![incoming.length]!;
  if (overlap === 0) return { kind: "none" };

  const backward = Array.from(
    { length: rows },
    () => new Uint16Array(columns),
  );
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    for (let j = incoming.length - 1; j >= 0; j -= 1) {
      backward[i]![j] = sameMessage(prior[i]!, incoming[j]!)
        ? backward[i + 1]![j + 1]! + 1
        : Math.max(backward[i + 1]![j]!, backward[i]![j + 1]!);
    }
  }

  const candidates: Array<readonly [number, number]> = [];
  for (let i = 0; i < prior.length; i += 1) {
    for (let j = 0; j < incoming.length; j += 1) {
      if (
        sameMessage(prior[i]!, incoming[j]!)
        && forward[i]![j]! + 1 + backward[i + 1]![j + 1]! === overlap
      ) {
        candidates.push([i, j] as const);
      }
    }
  }

  if (candidates.length !== overlap) return { kind: "ambiguous" };
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1]!;
    const current = candidates[index]!;
    if (current[0] <= previous[0] || current[1] <= previous[1]) {
      return { kind: "ambiguous" };
    }
  }
  return { kind: "unique", pairs: candidates };
}

/**
 * Return every legal contiguous position of incoming[0] in prior's coordinate
 * system. This is used only as a competing-boundary ambiguity check: a window
 * that looks contained must fail closed if another exact boundary overlap could
 * instead represent newly appended/prepended evidence.
 */
function legalAlignmentOffsets(
  prior: ChatGptContextPublisherMessage[],
  incoming: ChatGptContextPublisherMessage[],
): number[] {
  const offsets: number[] = [];
  for (let offset = -(incoming.length - 1); offset <= prior.length - 1; offset += 1) {
    const overlapStart = Math.max(0, offset);
    const overlapEnd = Math.min(prior.length, offset + incoming.length);
    if (overlapStart >= overlapEnd) continue;
    let matches = true;
    for (let coordinate = overlapStart; coordinate < overlapEnd; coordinate += 1) {
      if (!sameMessage(
        prior[coordinate]!,
        incoming[coordinate - offset]!,
      )) {
        matches = false;
        break;
      }
    }
    if (matches) offsets.push(offset);
  }
  return offsets;
}

function newMessageId(
  conversationId: string,
  direction: "initial" | "before" | "after",
  anchorId: string,
  offset: number,
  message: ChatGptContextPublisherMessage,
): string {
  return `ctx-message-${sha256(
    `dlmf/chatgpt-context-message/v3\0${conversationId}\0${direction}\0${anchorId}\0${offset}\0${message.role}\0${message.text}`,
  ).slice(0, 32)}`;
}

function newCapturedMessages(
  conversationId: string,
  messages: ChatGptContextPublisherMessage[],
  direction: "initial" | "before" | "after",
  anchorId: string,
): ChatGptCapturedMessage[] {
  return messages.map((message, index) => ({
    id: newMessageId(conversationId, direction, anchorId, index, message),
    role: message.role,
    text: message.text,
  }));
}

function mergeVisibleContext(
  conversationId: string,
  priorCaptured: ChatGptCapturedMessage[],
  incoming: ChatGptContextPublisherMessage[],
): ChatGptCapturedMessage[] {
  if (priorCaptured.length === 0) {
    return newCapturedMessages(
      conversationId,
      validateMessageSet(incoming, "merged"),
      "initial",
      "root",
    );
  }

  const prior = priorCaptured.map(visible);
  validateMessageSet(prior, "prior");
  validateMessageSet(incoming, "incoming");

  if (sameSequence(prior, incoming)) {
    return structuredClone(priorCaptured);
  }

  const boundaryOffsets = legalAlignmentOffsets(prior, incoming);
  if (boundaryOffsets.length > 1) {
    throw new Error(
      "context publisher visible context has ambiguous repeated overlap",
    );
  }

  const alignment = uniqueOrderedAlignment(prior, incoming);
  if (alignment.kind === "none") {
    throw new Error(
      "context publisher cannot safely merge visible context with the prior capture",
    );
  }
  if (alignment.kind === "ambiguous") {
    throw new Error(
      "context publisher visible context has ambiguous repeated overlap",
    );
  }

  const allIncomingMatched = alignment.pairs.length === incoming.length;
  if (allIncomingMatched) {
    const competingBoundaryExtension = boundaryOffsets.some((offset) =>
      offset < 0 || offset + incoming.length > prior.length
    );
    if (competingBoundaryExtension) {
      throw new Error(
        "context publisher visible context has ambiguous repeated overlap",
      );
    }
    return structuredClone(priorCaptured);
  }

  const merged: ChatGptCapturedMessage[] = [];
  let priorCursor = 0;
  let incomingCursor = 0;
  for (const [priorIndex, incomingIndex] of alignment.pairs) {
    const priorGap = priorCaptured.slice(priorCursor, priorIndex);
    const incomingGap = incoming.slice(incomingCursor, incomingIndex);
    if (priorGap.length > 0 && incomingGap.length > 0) {
      throw new Error(
        "context publisher cannot safely order interleaved visible context",
      );
    }
    merged.push(...structuredClone(priorGap));
    if (incomingGap.length > 0) {
      merged.push(...newCapturedMessages(
        conversationId,
        incomingGap,
        "before",
        priorCaptured[priorIndex]!.id,
      ));
    }
    merged.push(structuredClone(priorCaptured[priorIndex]!));
    priorCursor = priorIndex + 1;
    incomingCursor = incomingIndex + 1;
  }

  const priorTail = priorCaptured.slice(priorCursor);
  const incomingTail = incoming.slice(incomingCursor);
  if (priorTail.length > 0 && incomingTail.length > 0) {
    throw new Error(
      "context publisher cannot safely order interleaved visible context",
    );
  }
  merged.push(...structuredClone(priorTail));
  if (incomingTail.length > 0) {
    const anchor = alignment.pairs.at(-1);
    if (anchor === undefined) {
      throw new Error("context publisher overlap invariant failed");
    }
    merged.push(...newCapturedMessages(
      conversationId,
      incomingTail,
      "after",
      priorCaptured[anchor[0]]!.id,
    ));
  }

  validateMessageSet(merged.map(visible), "merged");
  return merged;
}

function assertOwnedSnapshot(
  snapshot: ChatGptCapturedConversation,
): ChatGptCapturedConversation {
  if (
    snapshot.metadata?.transport !== CHATGPT_CONTEXT_PUBLISHER_TRANSPORT
    || snapshot.metadata?.publisherContract !== CHATGPT_CONTEXT_PUBLISHER_CONTRACT
  ) {
    throw new Error(
      "context publisher refuses to overwrite a capture owned by another transport",
    );
  }
  validateMessageSet(snapshot.messages.map(visible), "prior");
  return snapshot;
}

export class ChatGptContextPublisher {
  readonly #publishSnapshot: ChatGptContextPublisherOptions["publishSnapshot"];
  readonly #readCurrentSnapshot:
    | ChatGptContextPublisherOptions["readCurrentSnapshot"]
    | undefined;
  readonly #clock: () => Date;
  readonly #conversationIdFactory: () => string;
  readonly #lastSnapshotByConversation =
    new Map<string, ChatGptCapturedConversation>();
  readonly #conversationQueues = new Map<string, Promise<void>>();

  constructor(options: ChatGptContextPublisherOptions) {
    this.#publishSnapshot = options.publishSnapshot;
    this.#readCurrentSnapshot = options.readCurrentSnapshot;
    this.#clock = options.clock ?? (() => new Date());
    this.#conversationIdFactory =
      options.conversationIdFactory
      ?? (() => `chatgpt-context-${randomUUID()}`);
  }

  async publish(
    rawInput: ChatGptContextPublisherInput,
  ): Promise<ChatGptContextPublisherResult> {
    const input = validateInput(rawInput);
    const conversationId = input.conversationId
      ?? requireConversationId(this.#conversationIdFactory());

    return this.#runConversationExclusive(conversationId, async () => {
      for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
        const durablePrior = await this.#readCurrentSnapshot?.(conversationId);
        const inMemoryPrior = this.#lastSnapshotByConversation.get(conversationId);
        const priorSnapshot = (() => {
          if (durablePrior !== undefined) return assertOwnedSnapshot(durablePrior);
          if (inMemoryPrior !== undefined) return assertOwnedSnapshot(inMemoryPrior);
          return undefined;
        })();

        const selectedMessages = mergeVisibleContext(
          conversationId,
          priorSnapshot?.messages ?? [],
          input.messages,
        );
        const priorTitle =
          typeof priorSnapshot?.metadata?.title === "string"
            ? priorSnapshot.metadata.title
            : undefined;
        const effectiveTitle = input.title ?? priorTitle;
        const latestVisibleMessageCount = input.messages.length;

        const captureDigest = sha256(
          JSON.stringify({
            publisherFormatVersion: PUBLISHER_FORMAT_VERSION,
            messages: selectedMessages.map((message) => ({
              id: message.id,
              role: message.role,
              text: message.text,
            })),
            contextCompleteness: input.contextCompleteness,
            latestVisibleMessageCount,
            title: effectiveTitle ?? null,
          }),
        );
        const priorCaptureDigest =
          typeof priorSnapshot?.metadata?.contextCaptureDigest === "string"
            ? priorSnapshot.metadata.contextCaptureDigest
            : undefined;

        let updatedAt: string;
        if (priorCaptureDigest === captureDigest && priorSnapshot !== undefined) {
          updatedAt = priorSnapshot.updatedAt;
        } else {
          const nowMillis = this.#clock().getTime();
          if (!Number.isFinite(nowMillis)) {
            throw new Error("context publisher clock returned an invalid timestamp");
          }
          const priorMillis = priorSnapshot === undefined
            ? Number.NEGATIVE_INFINITY
            : Date.parse(priorSnapshot.updatedAt);
          updatedAt = new Date(Math.max(nowMillis, priorMillis + 1)).toISOString();
        }

        const revision =
          `context-${updatedAt.replace(/[^0-9]/gu, "").slice(0, 17)}-${captureDigest.slice(0, 16)}`;
        const snapshot: ChatGptCapturedConversation = {
          contract: CHATGPT_CAPTURE_CONTRACT,
          conversationId,
          revision,
          status: "completed",
          updatedAt,
          messages: selectedMessages,
          metadata: {
            transport: CHATGPT_CONTEXT_PUBLISHER_TRANSPORT,
            publisherContract: CHATGPT_CONTEXT_PUBLISHER_CONTRACT,
            publisherFormatVersion: PUBLISHER_FORMAT_VERSION,
            captureKind: "model_visible_context",
            captureBoundary: "user_requested_snapshot",
            statusSemantics: "capture_snapshot_complete",
            threadLifecycle: "unknown",
            contextCompleteness: input.contextCompleteness,
            contextCaptureDigest: captureDigest,
            authoritativeTranscript: false,
            userConfirmed: true,
            accumulationPolicy: "monotonic_visible_context",
            latestVisibleMessageCount,
            messageCount: selectedMessages.length,
            userMessageCount:
              selectedMessages.filter((item) => item.role === "user").length,
            assistantMessageCount:
              selectedMessages.filter((item) => item.role === "assistant").length,
            ...(effectiveTitle === undefined ? {} : { title: effectiveTitle }),
          },
        };

        try {
          const result = await this.#publishSnapshot(
            snapshot,
            priorSnapshot?.revision ?? null,
          );
          this.#lastSnapshotByConversation.set(
            conversationId,
            structuredClone(snapshot),
          );
          return {
            contract: CHATGPT_CONTEXT_PUBLISHER_CONTRACT,
            transport: CHATGPT_CONTEXT_PUBLISHER_TRANSPORT,
            conversationId,
            outcome: result.outcome,
            publishedMessageCount: selectedMessages.length,
            contextCompleteness: input.contextCompleteness,
            authoritativeTranscript: false,
            canonicalMemoryWrites: 0,
            captureInbox: {
              contract: result.contract ?? "dlmf/chatgpt-capture-inbox/v1",
              conversationIdHash: result.conversationIdHash,
              revisionHash: result.revisionHash,
              updatedAt: result.updatedAt,
              status: result.status,
            },
          };
        } catch (error) {
          if (
            error instanceof ChatGptCaptureConflictError
            && error.reason === "precondition_failed"
            && this.#readCurrentSnapshot !== undefined
            && attempt < MAX_CAS_ATTEMPTS
          ) {
            continue;
          }
          throw error;
        }
      }
      throw new Error("context publisher CAS retry limit exceeded");
    });
  }

  async #runConversationExclusive<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.#conversationQueues.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#conversationQueues.set(conversationId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#conversationQueues.get(conversationId) === tail) {
        this.#conversationQueues.delete(conversationId);
      }
    }
  }
}
