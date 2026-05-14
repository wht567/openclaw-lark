/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Generic card action handler registry.
 *
 * Card action handlers are registered by action name (from button
 * `value.action` or form submission tag).  New card types only need
 * to `registerCardAction('my_action', handler)` — no changes to
 * event-handlers.ts required.
 */

import { dispatchSyntheticTextMessage as dispatchSynthetic } from '../messaging/inbound/synthetic-message';
import { larkLogger } from '../core/lark-logger';
import type { MonitorContext } from './types';

const log = larkLogger('channel/card-action-registry');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Normalised card action event extracted from the raw
 * `card.action.trigger` WebSocket payload.
 *
 * Covers button clicks, form submissions, and mixed form+button events.
 */
export interface CardActionEvent {
  /** Routing key — from `action.value.action`, button `name`, or `tag`. */
  action: string;
  /** Operator who triggered the action. */
  senderOpenId?: string;
  /** Chat where the card lives. */
  openChatId?: string;
  /** Card message ID. */
  openMessageId?: string;
  /** Form values (set for `form_submit` and button-with-form events). */
  formValue?: Record<string, unknown>;
  /** Full `action.value` object (custom fields beyond `action`). */
  actionValue?: Record<string, unknown>;
  /** Raw tag from the event (`button`, `form_submit`, etc.). */
  actionTag?: string;
  /** Raw name from the event (button name, form name). */
  actionName?: string;
  /** The original, un-normalised event payload. */
  rawEvent?: unknown;
}

/**
 * Structured answers extracted from a card action.
 *
 * Keys are question / field identifiers; values are user-provided answers.
 */
export type CardActionAnswers = Record<string, string>;

/**
 * A card action handler function.
 *
 * Receives the normalised event and the full monitor context so it can
 * read config, inject synthetic messages, update cards, etc.
 *
 * Returns a Feishu card-action callback response (`{ toast?, card? }`)
 * or `undefined` to signal "not handled".
 */
export type CardActionHandler = (
  event: CardActionEvent,
  ctx: MonitorContext,
) => Promise<unknown | undefined> | (unknown | undefined);

// ---------------------------------------------------------------------------
// Simple-card convenience factory
// ---------------------------------------------------------------------------

export interface SimpleCardActionConfig {
  /**
   * Parse answers from the normalised event.
   *
   * Return `null` when the data is invalid / incomplete —
   * the framework will return an error toast to the user.
   */
  extractAnswers: (event: CardActionEvent) => CardActionAnswers | null;
  /**
   * Format the extracted answers into the text that will be injected
   * as a synthetic message for the AI to process.
   */
  formatAnswerText: (answers: CardActionAnswers) => string;
  /**
   * Optional: build a "processing" card shown immediately to the
   * clicking user via the callback return value.
   */
  buildProcessingCard?: (answers: CardActionAnswers) => Record<string, unknown>;
}

/**
 * Create a card action handler that follows the standard
 * "extract → inject synthetic message → update card" pipeline.
 *
 * Use this for most card types; register a full `CardActionHandler`
 * directly when you need complex logic (e.g. OAuth flows).
 */
export function createSimpleCardHandler(config: SimpleCardActionConfig): CardActionHandler {
  return (event, ctx) => {
    const answers = config.extractAnswers(event);
    if (!answers) {
      log.warn(`simple card handler: invalid data for action=${event.action}`);
      return { toast: { type: 'error' as const, content: '无法解析提交的数据，请重试' } };
    }

    const text = config.formatAnswerText(answers);

    if (event.openChatId && event.senderOpenId) {
      const syntheticMsgId = `card-action:${event.action}:${Date.now()}`;
      setImmediate(() => {
        dispatchSynthetic({
          cfg: ctx.cfg,
          accountId: ctx.accountId,
          chatId: event.openChatId!,
          senderOpenId: event.senderOpenId!,
          text,
          syntheticMessageId: syntheticMsgId,
          replyToMessageId: event.openMessageId ?? syntheticMsgId,
          runtime: { log: ctx.log, error: ctx.error },
        }).catch((err: unknown) => ctx.error(`synthetic message for action=${event.action} failed: ${String(err)}`));
      });
    } else {
      log.warn(`simple card handler: missing chat/sender for action=${event.action}, synthetic message skipped`);
    }

    return {
      toast: { type: 'success' as const, content: '已收到' },
      card: config.buildProcessingCard
        ? { type: 'raw' as const, data: config.buildProcessingCard(answers) }
        : undefined,
    };
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const cardActionHandlers = new Map<string, CardActionHandler>();

/**
 * Register a handler for the given card action.
 *
 * The action string must match the `value.action` field of the card
 * button (or the derived action for form submissions).
 */
export function registerCardAction(action: string, handler: CardActionHandler): void {
  if (cardActionHandlers.has(action)) {
    log.warn(`card action "${action}" is already registered; overwriting`);
  }
  cardActionHandlers.set(action, handler);
  log.info(`registered card action: ${action}`);
}

/** Look up a handler by action name. */
export function getCardActionHandler(action: string): CardActionHandler | undefined {
  return cardActionHandlers.get(action);
}

// ---------------------------------------------------------------------------
// Event normalisation
// ---------------------------------------------------------------------------

/**
 * Extract the routing action and normalised fields from a raw
 * `card.action.trigger` event payload.
 *
 * Returns `null` when the payload doesn't carry any recognisable action.
 */
export function extractActionFromEvent(data: unknown): CardActionEvent | null {
  try {
    const event = data as Record<string, unknown>;

    const operatorOpenId = (event.operator as Record<string, unknown> | undefined)?.open_id as string | undefined;
    const openChatId = (event.open_chat_id as string) ?? (event.context as Record<string, unknown> | undefined)?.open_chat_id as string | undefined;
    const openMessageId = (event.open_message_id as string) ?? (event.context as Record<string, unknown> | undefined)?.open_message_id as string | undefined;

    const action = event.action as Record<string, unknown> | undefined;
    const tag = action?.tag as string | undefined;
    const name = action?.name as string | undefined;
    const formValue = action?.form_value as Record<string, unknown> | undefined;
    const value = action?.value as Record<string, unknown> | undefined;

    let actionKey: string | undefined;

    // Priority: value.action (buttons) > name-based detection (form submit) > tag (form_submit)
    if (value?.action && typeof value.action === 'string') {
      actionKey = value.action;
    } else if (name && typeof name === 'string') {
      // Some form-submit buttons encode the action in the button name as
      // a prefix (e.g. "ask_user_submit_<questionId>").
      // Handlers that need the suffix can find it in `actionName`.
      const underscoreIdx = name.lastIndexOf('_');
      if (underscoreIdx > 0) {
        const candidate = name.slice(0, underscoreIdx);
        // Accept both the candidate prefix and the full name
        actionKey = candidate;
      }
    } else if (tag === 'form_submit') {
      actionKey = 'form_submit';
    } else if (tag === 'button' && formValue) {
      // Button with form_value — treat as submit
      actionKey = 'form_submit';
    }

    if (!actionKey) return null;

    return {
      action: actionKey,
      senderOpenId: operatorOpenId,
      openChatId: openChatId as string | undefined,
      openMessageId: openMessageId as string | undefined,
      formValue,
      actionValue: value,
      actionTag: tag,
      actionName: name,
      rawEvent: data,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Built-in: quick_question — 点击按钮直接提问，AI 即时回答
// ---------------------------------------------------------------------------

registerCardAction('quick_question', createSimpleCardHandler({
  extractAnswers: (event) => {
    const question = event.actionValue?.question as string | undefined;
    if (!question) return null;
    return { question };
  },
  formatAnswerText: ({ question }) => `用户点击了快捷问题：「${question}」\n请针对以上问题进行回答。`,
}));
