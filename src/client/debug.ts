// On-screen event log for testing on phones, where there are no dev tools.
// Loaded only when the URL has ?debug (before the #), for example
// https://example.com/?debug#/ . Shows focus, keyboard, and resize events.

const MAX_LINES = 40;

export function startDebugLog(): void {
  const box = document.createElement("pre");
  Object.assign(box.style, {
    position: "fixed",
    left: "0",
    right: "0",
    bottom: "0",
    zIndex: "10000",
    maxHeight: "35vh",
    margin: "0",
    padding: "4px 6px",
    overflow: "auto",
    background: "rgb(0 0 0 / 0.8)",
    color: "#7f7",
    font: "11px/1.3 monospace",
    pointerEvents: "none",
    whiteSpace: "pre-wrap",
  });
  document.body.append(box);
  const start = performance.now();
  const lines: string[] = [];

  const describe = (el: EventTarget | null): string => {
    if (!el) return "null";
    if (el === window) return "window";
    if (el === document) return "document";
    const e = el as HTMLElement;
    return e.id ? `#${e.id}` : e.tagName ? `${e.tagName.toLowerCase()}${e.className ? `.${String(e.className).split(" ")[0]}` : ""}` : "?";
  };

  const log = (text: string) => {
    lines.push(`${((performance.now() - start) / 1000).toFixed(2)} ${text}`);
    if (lines.length > MAX_LINES) lines.shift();
    box.textContent = lines.join("\n");
    box.scrollTop = box.scrollHeight;
  };

  log(`debug on, active: ${describe(document.activeElement)}`);
  document.addEventListener("focusin", (e) => log(`focusin ${describe(e.target)}`), true);
  document.addEventListener(
    "focusout",
    (e) => log(`focusout ${describe(e.target)} → ${describe((e as FocusEvent).relatedTarget)}`),
    true,
  );
  window.addEventListener("blur", () => log(`window blur (active ${describe(document.activeElement)})`));
  window.addEventListener("focus", () => log("window focus"));
  document.addEventListener("visibilitychange", () => log(`visibility ${document.visibilityState}`));
  window.addEventListener("resize", () => log(`resize ${innerWidth}x${innerHeight}`));
  window.visualViewport?.addEventListener("resize", () =>
    log(`viewport ${Math.round(visualViewport!.width)}x${Math.round(visualViewport!.height)}`),
  );
  window.addEventListener("hashchange", () => log(`hash ${location.hash}`));
  for (const type of ["keydown", "beforeinput", "input", "compositionstart", "compositionend", "change", "submit"]) {
    document.addEventListener(
      type,
      (e) => {
        const k = e as KeyboardEvent & InputEvent;
        const detail = type === "keydown" ? ` key=${k.key} code=${k.keyCode}` : k.inputType ? ` ${k.inputType}` : "";
        log(`${type} ${describe(e.target)}${detail}`);
      },
      true,
    );
  }
  // Catch blur() calls from page code, with the caller.
  const blur = HTMLElement.prototype.blur;
  HTMLElement.prototype.blur = function (this: HTMLElement) {
    log(`blur() on ${describe(this)} from ${new Error().stack?.split("\n")[2]?.trim() ?? "?"}`);
    return blur.call(this);
  };
}
