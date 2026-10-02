import { createHash, randomUUID } from "node:crypto";

import {
  CHATGPT_CAPTURE_CONTRACT,
  type ChatGptCapturedConversation,
  type ChatGptCapturedMessage,
} from "../source-adapters/chatgpt-capture-adapter.js";
import type {
  ChatGptCaptureInboxCurrentVersion,
  ChatGptCaptureInboxWriteResult,
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
  ): Promise<ChatGptCaptureInboxWriteResult & { contract?: string }>;
  readCurrentVersion?: (
    conversationId: string,
  ) => Promise<ChatGptCaptureInboxCurrentVersion | undefined>;
  clock?: () => Date;
  conversationIdFactory?: () => string;
}

const MAX_MESSAGES = 512;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TOTAL_TEXT_BYTES = 768 * 1024;
const MAX_TITLE_BYTES = 1024;
const CONTEXT_CONVERSATION_ID = /^chatgpt-context-[A-Za-z0-9._:-]{8,220}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
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

function validateInput(input: ChatGptContextPublisherInput): ChatGptContextPublisherInput {
  if (
    input.contextCompleteness !== "full_visible_context"
    && input.contextCompleteness !== "partial_visible_context"
    && input.contextCompleteness !== "unknown"
  ) {
    throw new Error("contextCompleteness is invalid");
  }
  if (!Array.isArray(input.messages) || input.messages.length < 1) {
    throw new Error("context publisher requires at least one visible message");
  }
  if (input.messages.length > MAX_MESSAGES) {
    throw new Error("context publisher message count exceeds the limit");
  }

  let totalTextBytes = 0;
  const messages = input.messages.map((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") {
      throw new Error(`messages[${index}].role must be user or assistant`);
    }
    const text = requireText(message.text, `messages[${index}].text`);
    totalTextBytes += utf8Bytes(text);
    if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) {
      throw new Error("context publisher total text exceeds the byte limit");
    }
    return { role: message.role, text };
  });

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

function messageId(
  conversationId: string,
  message: ChatGptContextPublisherMessage,
  index: number,
): string {
  return `ctx-message-${index.toString().padStart(4, "0")}-${sha256(
    `dlmf/chatgpt-context-message/v1\0${conversationId}\0${index}\0${message.role}\0${message.text}`,
  ).slice(0, 20)}`;
}

export class ChatGptContextPublisher {
  readonly #publishSnapshot: ChatGptContextPublisherOptions["publishSnapshot"];
  readonly #readCurrentVersion:
    | ChatGptContextPublisherOptions["readCurrentVersion"]
    | undefined;
  readonly #clock: () => Date;
  readonly #conversationIdFactory: () => string;
  readonly #lastCaptureByConversation = new Map<
    string,
    { captureDigest: string; updatedAt: string }
  >();
  readonly #conversationQueues = new Map<string, Promise<void>>();

  constructor(options: ChatGptContextPublisherOptions) {
    this.#publishSnapshot = options.publishSnapshot;
    this.#readCurrentVersion = options.readCurrentVersion;
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
    const selectedMessages: ChatGptCapturedMessage[] = input.messages.map(
      (message, index) => ({
        id: messageId(conversationId, message, index),
        role: message.role,
        text: message.text,
      }),
    );
    const captureDigest = sha256(
      JSON.stringify({
        messages: selectedMessages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
        })),
        contextCompleteness: input.contextCompleteness,
        title: input.title ?? null,
      }),
    );
    const inMemoryPrior = this.#lastCaptureByConversation.get(conversationId);
    const durablePrior = await this.#readCurrentVersion?.(conversationId);
    const prior = (() => {
      if (durablePrior === undefined) return inMemoryPrior;
      if (inMemoryPrior === undefined) {
        return {
          captureDigest: durablePrior.contextCaptureDigest ?? "",
          updatedAt: durablePrior.updatedAt,
        };
      }
      return Date.parse(durablePrior.updatedAt) >= Date.parse(inMemoryPrior.updatedAt)
        ? {
            captureDigest: durablePrior.contextCaptureDigest ?? "",
            updatedAt: durablePrior.updatedAt,
          }
        : inMemoryPrior;
    })();
    let updatedAt: string;
    if (prior?.captureDigest === captureDigest) {
      updatedAt = prior.updatedAt;
    } else {
      const nowMillis = this.#clock().getTime();
      if (!Number.isFinite(nowMillis)) {
        throw new Error("context publisher clock returned an invalid timestamp");
      }
      const priorMillis = prior === undefined ? Number.NEGATIVE_INFINITY : Date.parse(prior.updatedAt);
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
        captureKind: "model_visible_context",
        captureBoundary: "user_requested_snapshot",
        statusSemantics: "capture_snapshot_complete",
        threadLifecycle: "unknown",
        contextCompleteness: input.contextCompleteness,
        contextCaptureDigest: captureDigest,
        authoritativeTranscript: false,
        userConfirmed: true,
        messageCount: selectedMessages.length,
        userMessageCount: selectedMessages.filter((item) => item.role === "user").length,
        assistantMessageCount: selectedMessages.filter((item) => item.role === "assistant").length,
        ...(input.title === undefined ? {} : { title: input.title }),
      },
    };

    const result = await this.#publishSnapshot(snapshot);
    this.#lastCaptureByConversation.set(conversationId, {
      captureDigest,
      updatedAt,
    });
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
    });
  }

  async #runConversationExclusive<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#conversationQueues.get(conversationId) ?? Promise.resolve();
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
