// Keep authoring available when the optional remote syntax-highlighting editor fails.
export function registerEditorFallback() {
  if (customElements.get("code-editor")) {
    return;
  }
  customElements.define(
    "code-editor",
    class extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = `<style>:host{display:block;height:100%;color:#d4d4d8;background:#18181b;font:12px system-ui}.editor{display:flex;flex-direction:column;height:100%;min-height:0}.status{display:flex;justify-content:space-between;gap:8px;padding:10px 12px;color:#a1a1aa;border-bottom:1px solid #27272a}.status small{font-size:10px}textarea{flex:1;min-height:0;box-sizing:border-box;width:100%;resize:none;border:0;outline:0;padding:16px;color:#d4d4d8;caret-color:#60a5fa;background:#09090b;font:12px/1.7 ui-monospace,monospace;tab-size:2}textarea:focus-visible{box-shadow:inset 0 0 0 1px #3b82f6}</style><div class="editor"><div class="status"><span></span><small>Plain text · rich editor unavailable</small></div><textarea aria-label="Source code" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea></div>`;
        this.input = root.querySelector("textarea");
        this.input.addEventListener("input", () =>
          this.dispatchEvent(new CustomEvent("change", { detail: this.value })),
        );
      }
      get value() {
        return this.input.value;
      }
      set value(value) {
        this.input.value = value ?? "";
      }
      set status(value) {
        this.shadowRoot.querySelector(".status span").textContent = value;
        this.input.setAttribute("aria-label", `Source code: ${value}`);
      }
      set language(value) {
        this.input.dataset.language = value;
      }
    },
  );
}
