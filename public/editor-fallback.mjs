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
        this.className = "block h-full bg-[#18181b] font-[12px_system-ui] text-[#d4d4d8]";
        root.innerHTML = `<link rel="stylesheet" href="/css/tailwind.css"><div class="flex h-full min-h-0 flex-col"><div class="status flex justify-between gap-2 border-b border-[#27272a] px-3 py-2.5 text-[#a1a1aa]"><span></span><small class="text-[10px]">Plain text · rich editor unavailable</small></div><textarea class="box-border min-h-0 w-full flex-1 resize-none border-0 bg-[#09090b] p-4 font-mono text-[12px]/[1.7] text-[#d4d4d8] outline-none caret-[#60a5fa] [tab-size:2] focus-visible:shadow-[inset_0_0_0_1px_#3b82f6]" aria-label="Source code" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea></div>`;
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
