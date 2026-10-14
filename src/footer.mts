// @ts-nocheck
import { fullSummary, format } from "./formatter.mts";
export const STATUS_KEY = "footer-compositor:right:0:tmux-monitor";
const PREFIX = "footer-compositor:dynamic:";
// Structural protocol inspected in pi-footer-compositor's implementation.
// Do not import the compositor or estimate budgets from terminal columns.
export class FooterAdapter {
  constructor(pi, ctx, config, diagnostic) {
    Object.assign(this, { pi, ctx, config, diagnostic });
    this.slots = [];
    this.capability = "missing";
    this.accept = (payload) => {
      if (
        this.retired ||
        !payload ||
        payload.version !== 1 ||
        typeof payload.instanceId !== "string" ||
        !payload.instanceId ||
        typeof payload.register !== "function" ||
        payload.instanceId === this.instanceId
      )
        return;
      try {
        const remove = payload.register({
          key: STATUS_KEY,
          render: ({ maxWidth, theme }) =>
            this.retired
              ? ""
              : format(this.slots, this.config, theme, maxWidth).text,
        });
        if (typeof remove !== "function") {
          this.failedRegistration();
          return;
        }
        this.unregister?.();
        this.unregister = remove;
        this.instanceId = payload.instanceId;
        this.capability = "dynamic-v1";
      } catch {
        this.failedRegistration();
      }
      this.publish(this.slots);
    };
    this.subscriptions = [
      pi.events.on(PREFIX + "available", this.accept),
      pi.events.on(PREFIX + "unavailable", (payload) => {
        if (
          this.retired ||
          payload?.version !== 1 ||
          payload.instanceId !== this.instanceId
        )
          return;
        this.unregister?.();
        this.unregister = undefined;
        this.instanceId = undefined;
        this.capability = "missing";
        this.publish(this.slots);
        this.discover();
        if (!this.instanceId) this.missing();
      }),
    ];
    this.discover();
    if (!this.instanceId) this.missing();
  }
  failedRegistration() {
    if (this.registrationWarned) return;
    this.registrationWarned = true;
    this.diagnostic(
      "Compositor registration failed; retaining any working registration or static fallback",
    );
  }
  missing() {
    if (!this.warned) {
      this.warned = true;
      this.diagnostic(
        "Width-aware compositor capability unavailable; using static summary",
      );
    }
  }
  discover() {
    if (!this.retired)
      this.pi.events.emit(PREFIX + "discover", {
        version: 1,
        accept: this.accept,
      });
  }
  publish(slots) {
    if (this.retired) return;
    this.slots = slots;
    this.ctx.ui.setStatus(
      STATUS_KEY,
      fullSummary(slots, this.config, this.ctx.ui.theme) || undefined,
    );
  }
  stop() {
    if (this.retired) return;
    this.retired = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    this.unregister?.();
    this.unregister = undefined;
    this.instanceId = undefined;
    this.ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}
