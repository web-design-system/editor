class WdsCodeEditor extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:block;color:#20283b;font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.frame{display:grid;grid-template-columns:auto 1fr;overflow:hidden;border:1px solid #d9dce5;border-radius:8px;background:#fbfcff}.numbers{padding:10px 9px;text-align:right;color:#8992a5;background:#f1f3f8;user-select:none;white-space:pre}.pane{position:relative;min-width:0}.highlight,.input{box-sizing:border-box;margin:0;padding:10px;width:100%;min-height:var(--editor-min-height,220px);border:0;white-space:pre;tab-size:2;font:inherit;line-height:1.55;overflow:auto}.highlight{position:absolute;inset:0;pointer-events:none;color:#334155}.highlight .comment{color:#728096}.highlight .property{color:#7451a6}.highlight .value{color:#087e72}.input{position:relative;resize:vertical;background:transparent;color:transparent;caret-color:#171b2a;-webkit-text-fill-color:transparent;outline:none}.input::selection{background:#a5b4fc66}.status{padding:5px 10px;color:#68738a;background:#f1f3f8;font:12px system-ui,sans-serif}</style><div class="frame"><div class="numbers" aria-hidden="true"></div><div class="pane"><pre class="highlight" aria-hidden="true"></pre><textarea class="input" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="CSS tokens source"></textarea></div></div><div class="status" aria-live="polite">CSS · line 1</div>`;
    this.input = root.querySelector("textarea");
    this.numbers = root.querySelector(".numbers");
    this.highlight = root.querySelector(".highlight");
    this.status = root.querySelector(".status");
    this.input.addEventListener("input", () => {
      this.update();
      this.dispatchEvent(new Event("input", { bubbles: true }));
    });
    this.input.addEventListener("scroll", () => {
      this.numbers.scrollTop = this.input.scrollTop;
      this.highlight.scrollTop = this.input.scrollTop;
      this.highlight.scrollLeft = this.input.scrollLeft;
    });
    this.input.addEventListener("click", () => this.updateStatus());
    this.input.addEventListener("keyup", () => this.updateStatus());
    this.input.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") {
        return;
      }
      event.preventDefault();
      const { selectionStart: start, selectionEnd: end, value } = this.input;
      const selected = value.slice(start, end);
      let next;
      let cursor;
      if (event.shiftKey) {
        const begin = value.lastIndexOf("\n", start - 1) + 1;
        const finish = value.indexOf("\n", end);
        const selectedEnd = finish < 0 ? value.length : finish;
        const selectedLines = value.slice(begin, selectedEnd).split("\n");
        next = selectedLines.map((line) => line.replace(/^ {1,2}|^\t/, "")).join("\n");
        const before = value.slice(0, begin);
        const after = value.slice(selectedEnd);
        cursor = Math.max(begin, start - (value.slice(begin, start).match(/^(?: {1,2}|\t)/)?.[0].length || 0));
        this.input.value = `${before}${next}${after}`;
      } else if (start !== end && selected.includes("\n")) {
        const begin = value.lastIndexOf("\n", start - 1) + 1;
        const finish = value.indexOf("\n", end);
        const selectedEnd = finish < 0 ? value.length : finish;
        next = value.slice(begin, selectedEnd).replace(/^/gm, "  ");
        cursor = end + (next.length - selected.length);
        this.input.value = `${value.slice(0, begin)}${next}${value.slice(selectedEnd)}`;
      } else {
        next = `${value.slice(0, start)}  ${value.slice(end)}`;
        this.input.value = next;
        cursor = start + 2;
      }
      this.input.setSelectionRange(cursor, cursor);
      this.update();
      this.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  connectedCallback() {
    this.update();
  }
  get value() {
    return this.input.value;
  }
  set value(value) {
    this.input.value = String(value ?? "");
    this.update();
  }
  updateStatus() {
    const line = this.input.value.slice(0, this.input.selectionStart).split("\n").length;
    this.status.textContent = `CSS · line ${line}`;
  }
  update() {
    const lines = this.input.value.split("\n").length;
    this.numbers.textContent = Array.from({ length: lines }, (_, index) => index + 1).join("\n");
    this.highlight.replaceChildren();
    const tokens =
      this.input.value.match(/\/\*[\s\S]*?\*\/|--[\w-]+(?=\s*:)|#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl|rem|px|var)\b/g) || [];
    let cursor = 0;
    for (const token of tokens) {
      const index = this.input.value.indexOf(token, cursor);
      this.highlight.append(document.createTextNode(this.input.value.slice(cursor, index)));
      const span = document.createElement("span");
      span.className = token.startsWith("/*") ? "comment" : token.startsWith("--") ? "property" : "value";
      span.textContent = token;
      this.highlight.append(span);
      cursor = index + token.length;
    }
    this.highlight.append(document.createTextNode(this.input.value.slice(cursor) || " "));
    this.updateStatus();
  }
}
customElements.define("wds-code-editor", WdsCodeEditor);
