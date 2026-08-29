/**
 * Modal user-question interface (PLAN §7, §11).
 *
 * Implements the EngineUI surface consumed by the orchestration engine:
 *
 *   interface EngineUI {
 *     askUser(q: PendingQuestion): Promise<string>;
 *     notify(message: string, data?: Record<string, unknown>): void;
 *   }
 *
 * askUser renders the PendingQuestion (question, context bullets, choices) as
 * an overlay modal built with the documented `ctx.ui.custom(..., { overlay:
 * true })` API (extensions.md "Custom Components / Overlay Mode", tui.md
 * Patterns 1 for SelectList framing and the Container/Focusable rules for
 * embedded inputs). It never blocks the event loop: the promise from the
 * modal API is returned directly. Cancelling (esc) resolves with "" so the
 * engine can route the run to WAITING_FOR_USER.
 *
 * Degrades gracefully when no interactive TUI is available: the question is
 * announced via ctx.ui.notify and answered through the /gx-dev answer buffer.
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import type { Component, Focusable, SelectItem, TUI } from "@earendil-works/pi-tui";
import type { PendingQuestion } from "../domain/state.ts";
import type { EngineUI } from "../orchestration/engine.ts";

/** Pseudo-choice that switches the modal to free-text input. */
const FREE_TEXT_VALUE = "\u0000gx-dev-free-text";

export interface QuestionUIOptions {
  /**
   * Returns a pre-typed answer to consume instead of prompting (used by the
   * /gx-dev answer buffer in degraded flows), or null.
   */
  readonly takeBufferedAnswer?: () => string | null;
  /** Hook fired for every engine notification (wired to the workflow widget). */
  readonly onNotify?: (message: string, data?: Record<string, unknown>) => void;
}

type Done = (answer: string) => void;

class QuestionModal implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly question: PendingQuestion;
  private readonly done: Done;
  private readonly container = new Container();
  private selectList: SelectList | null = null;
  private input: Input | null = null;
  private resolved = false;

  /** Focusable — propagated to the embedded Input for IME cursor placement. */
  get focused(): boolean {
    return this.input?.focused ?? false;
  }
  set focused(value: boolean) {
    if (this.input) this.input.focused = value;
  }

  constructor(tui: TUI, theme: Theme, question: PendingQuestion, done: Done) {
    this.tui = tui;
    this.theme = theme;
    this.question = question;
    this.done = done;
    this.rebuild(false);
  }

  private rebuild(inputMode: boolean): void {
    const th = this.theme;
    this.container.clear();
    this.selectList = null;
    this.input = null;
    this.container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
    this.container.addChild(
      new Text(
        th.fg("muted", "gx-dev needs your input") +
          (this.question.severity === "material"
            ? th.fg("warning", " \u00B7 material decision")
            : th.fg("dim", " \u00B7 minor")),
        1,
        0,
      ),
    );
    this.container.addChild(new Text(th.fg("accent", th.bold(this.question.question)), 1, 0));
    for (const line of this.question.context) {
      this.container.addChild(new Text(th.fg("dim", `\u2022 ${line}`), 1, 0));
    }
    if (inputMode) {
      const input = new Input();
      input.onSubmit = (value: string) => this.finish(value.trim());
      this.input = input;
      this.container.addChild(input);
      this.container.addChild(
        new Text(th.fg("dim", "enter submit \u00B7 esc skip (answer later via /gx-dev answer)"), 1, 0),
      );
    } else {
      const choices: SelectItem[] = (this.question.choices ?? []).map((c) => ({
        value: c,
        label: c,
      }));
      choices.push({ value: FREE_TEXT_VALUE, label: "\u278E write your own answer\u2026" });
      const list = new SelectList(choices, Math.min(choices.length, 8), {
        selectedPrefix: (t: string) => th.fg("accent", t),
        selectedText: (t: string) => th.fg("accent", t),
        description: (t: string) => th.fg("muted", t),
        scrollInfo: (t: string) => th.fg("dim", t),
        noMatch: (t: string) => th.fg("warning", t),
      });
      list.onSelect = (item: SelectItem) => {
        if (item.value === FREE_TEXT_VALUE) {
          this.rebuild(true);
          this.tui.requestRender();
          return;
        }
        this.finish(item.value);
      };
      list.onCancel = () => this.finish("");
      this.selectList = list;
      this.container.addChild(list);
      this.container.addChild(
        new Text(th.fg("dim", "\u2191\u2193 choose \u00B7 enter select \u00B7 esc skip"), 1, 0),
      );
    }
    this.container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
  }

  private finish(answer: string): void {
    if (this.resolved) return;
    this.resolved = true;
    this.container.clear();
    this.done(answer);
  }

  handleInput(data: string): void {
    if (this.resolved) return;
    if (matchesKey(data, Key.escape)) {
      this.finish("");
      return;
    }
    if (this.input) this.input.handleInput(data);
    else this.selectList?.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.container.invalidate();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }
}

async function askUser(
  ctx: ExtensionContext,
  question: PendingQuestion,
  opts: QuestionUIOptions,
): Promise<string> {
  const buffered = opts.takeBufferedAnswer?.() ?? null;
  if (buffered !== null && buffered !== "") return buffered;

  if (ctx.mode !== "tui" || !ctx.hasUI) {
    const choices =
      question.choices !== undefined && question.choices.length > 0
        ? ` (choices: ${question.choices.join(" | ")})`
        : "";
    ctx.ui.notify(
      `gx-dev question [${question.severity}]: ${question.question}${choices} \u2014 reply with /gx-dev answer <text>`,
      "warning",
    );
    return "";
  }

  const answer = await ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => new QuestionModal(tui, theme, question, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "72%", minWidth: 56 },
    },
  );
  return answer ?? "";
}

export function createQuestionUI(ctx: ExtensionContext, opts: QuestionUIOptions = {}): EngineUI {
  return {
    askUser: (question: PendingQuestion) => askUser(ctx, question, opts),
    notify: (message: string, data?: Record<string, unknown>) => {
      opts.onNotify?.(message, data);
      if (!ctx.hasUI) return;
      // Map engine notification payloads onto toast severities: material
      // questions and explicit level hints surface as warnings.
      const level =
        data?.["severity"] === "material" || data?.["level"] === "warning" || data?.["level"] === "error"
          ? "warning"
          : "info";
      ctx.ui.notify(message, level);
    },
  };
}
