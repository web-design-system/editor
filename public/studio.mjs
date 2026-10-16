const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

// The studio edits the same draft object used by source commits and the code editor.
export function createStudio(area, files, onEdit) {
  document.querySelector("#workspace").classList.add("design-studio");
  const shell = area.querySelector(".studio-shell");
  const nav = area.querySelector(".studio-nav");
  const inspector = area.querySelector(".studio-inspector");
  const canvas = area.querySelector(".design-surface");
  const frame = area.querySelector("#draft-preview");
  const code = area.querySelector(".code-surface");
  const tabs = area.querySelector('[role="tablist"]');
  const fields = area.querySelector(".inspector-fields");
  const drawer = area.querySelector(".project-drawer");
  drawer.querySelector("summary").textContent = "Project & files";
  drawer.open = false;
  nav.insertAdjacentHTML(
    "afterbegin",
    '<div class="panel-title">Layers <span title="Select a layer to edit">◇</span></div><div id="layer-list" aria-label="Component layers"></div>',
  );
  inspector.prepend(tabs);
  inspector.append(code);
  area.querySelector(".inspector-drawer > summary").textContent = "Selected element";
  area.querySelector(".inspector-drawer").open = true;
  fields.innerHTML = `<p id="selected-element"></p><section class="property-section"><h2>Layout</h2>${select("display", "Display", ["", "block", "flex", "inline-flex", "grid", "inline-block", "none"])}${select("flex-direction", "Direction", ["", "row", "column", "row-reverse", "column-reverse"])}${select("align-items", "Align", ["", "flex-start", "center", "flex-end", "stretch"])}${select("justify-content", "Justify", ["", "flex-start", "center", "flex-end", "space-between"])}</section><section class="property-section"><h2>Spacing</h2><div class="spacing-fields"><div><span>Padding</span><div class="padding-grid">${["top", "left", "right", "bottom"].map((side) => `<input aria-label="Padding ${side}" data-style="padding-${side}" placeholder="auto" title="CSS length, e.g. 12px">`).join("")}<span>□</span></div></div><label>Gap<input data-style="gap" placeholder="normal"></label></div>${input("margin", "Margin")}</section><section class="property-section"><h2>Colors</h2>${input("background-color", "Background")}${input("color", "Text")}</section><section class="property-section"><h2>Effects</h2>${input("border-radius", "Radius")}${select("box-shadow", "Shadow", ["", "none", "0 1px 2px #0003", "0 4px 6px #0003", "0 10px 15px #0003"])}<label class="property-row">Opacity<input aria-label="Opacity" data-style="opacity" type="range" min="0" max="1" step="0.05" value="1"></label></section><section class="property-section"><h2>Element</h2><label>Classes<input id="element-classes" placeholder="Add CSS classes"></label><p id="style-status" role="status"></p></section>`;
  canvas.querySelector(".surface-heading").remove();
  canvas.insertAdjacentHTML(
    "afterbegin",
    '<div class="canvas-tools"><button type="button" id="zoom-out" aria-label="Zoom out">−</button><button type="button" id="zoom-reset" aria-label="Reset zoom">100%</button><button type="button" id="zoom-in" aria-label="Zoom in">+</button></div><span class="canvas-caption">COMPONENT CANVAS</span>',
  );
  area
    .querySelector(".studio-actions")
    .insertAdjacentHTML(
      "afterbegin",
      '<button type="button" id="preview-toggle" aria-pressed="false">Preview</button>',
    );
  area.querySelector("#save-source").textContent = "Save Component";
  code.querySelector(".surface-heading").innerHTML =
    '<span id="active-file-label">component.html</span><button type="button" id="copy-source">Copy</button>';
  let selected = 0;
  let zoom = 1;
  let preview = false;
  let holder;
  let nodes = [];
  const list = area.querySelector("#layer-list");
  // Same-origin access is solely for selection; the sandbox never permits scripts.
  frame.setAttribute("sandbox", "allow-same-origin");
  function parse() {
    holder = document.createElement("template");
    holder.innerHTML = files["component.html"];
    const root = holder.content.querySelector("template[component]")?.content || holder.content;
    nodes = [...root.querySelectorAll("*")].filter(
      (el) => !["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE"].includes(el.tagName),
    );
    selected = Math.min(selected, Math.max(0, nodes.length - 1));
    return root;
  }
  function selectLayer(index) {
    selected = index;
    list.querySelectorAll("button").forEach((button, i) => button.setAttribute("aria-pressed", String(i === selected)));
    const element = nodes[selected];
    area.querySelector("#selected-element").textContent = element ? element.localName : "No elements in this template";
    area.querySelector("#element-classes").value = element?.getAttribute("class") || "";
    const rendered = frame.contentDocument?.querySelector(`[data-studio-node="${selected}"]`);
    frame.contentDocument
      ?.querySelectorAll("[data-studio-selected]")
      .forEach((el) => el.removeAttribute("data-studio-selected"));
    if (rendered && !preview) {
      rendered.setAttribute("data-studio-selected", "");
    }
    const computed = rendered ? frame.contentWindow.getComputedStyle(rendered) : null;
    fields.querySelectorAll("[data-style]").forEach((control) => {
      control.disabled = !element;
      const value =
        element?.style.getPropertyValue(control.dataset.style) ||
        computed?.getPropertyValue(control.dataset.style) ||
        "";
      if (control.tagName === "SELECT") {
        control.value = [...control.options].some((option) => option.value === value) ? value : "";
      } else {
        control.value = value;
      }
    });
    area.querySelector("#element-classes").disabled = !element;
  }
  function refresh() {
    const root = parse();
    list.replaceChildren();
    nodes.forEach((node, index) => {
      const button = document.createElement("button");
      let depth = 0;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        depth++;
      }
      button.style.paddingLeft = `${12 + depth * 16}px`;
      button.textContent = `${node.localName === "svg" ? "◇" : "▱"}  ${node.localName}${node.classList.length ? `.${node.classList[0]}` : ""}`;
      button.type = "button";
      button.addEventListener("click", () => selectLayer(index));
      list.append(button);
    });
    const clone = root.cloneNode(true);
    const elements = [...clone.querySelectorAll("*")].filter(
      (el) => !["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE"].includes(el.tagName),
    );
    elements.forEach((el, index) => el.setAttribute("data-studio-node", index));
    clone.querySelectorAll("script, link, meta, base, iframe, object, embed, template").forEach((el) => el.remove());
    clone.querySelectorAll("*").forEach((el) => {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name) || ["href", "action", "formaction", "srcdoc"].includes(attr.name)) {
          el.removeAttribute(attr.name);
        }
      }
    });
    const container = document.createElement("div");
    container.append(clone);
    const css = (files["styles.css"] || "").replace(/@import[^;]+;/g, "").replace(/<\/style/gi, "<\\/style");
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; form-action 'none'"><style>html,body{margin:0;min-height:100%;background:transparent;color:#d4d4d8;font:14px system-ui}body{min-height:100vh;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:40px}*{box-sizing:border-box}${utilities()}${css}</style><style>[data-studio-selected]{outline:2px solid #3b82f6!important;outline-offset:6px!important;position:relative}[data-studio-selected]::after{content:attr(data-studio-label);position:absolute;bottom:calc(100% + 8px);left:-8px;background:#3b82f6;color:white;font:10px system-ui;padding:3px 6px;border-radius:2px;white-space:nowrap;pointer-events:none}</style></head><body>${container.innerHTML}</body></html>`;
    selectLayer(selected);
  }
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    doc.querySelectorAll("[data-studio-node]").forEach((el) => el.setAttribute("data-studio-label", el.localName));
    doc.addEventListener("click", (event) => {
      event.preventDefault();
      if (!preview) {
        const el = event.target.closest("[data-studio-node]");
        if (el) {
          selectLayer(Number(el.dataset.studioNode));
        }
      }
    });
    selectLayer(selected);
  });
  const write = () => {
    files["component.html"] = holder.innerHTML;
    onEdit();
    refresh();
  };
  fields.querySelectorAll("[data-style]").forEach((control) =>
    control.addEventListener("change", () => {
      const node = nodes[selected];
      if (!node) {
        return;
      }
      const property = control.dataset.style;
      const value = control.value.trim();
      if (value && !CSS.supports(property, value)) {
        area.querySelector("#style-status").textContent = `Enter a valid ${property} value, e.g. 12px.`;
        return;
      }
      area.querySelector("#style-status").textContent = "";
      node.style.setProperty(property, value);
      write();
    }),
  );
  area.querySelector("#element-classes").addEventListener("change", (event) => {
    if (nodes[selected]) {
      nodes[selected].setAttribute("class", event.target.value);
      write();
    }
  });
  tabs.querySelectorAll("button").forEach((button) =>
    button.addEventListener("click", () => {
      canvas.hidden = false;
      area.querySelector(".inspector-drawer").hidden = button.dataset.mode === "code";
    }),
  );
  function setZoom(value) {
    zoom = Math.max(0.25, Math.min(2, value));
    frame.style.transform = `scale(${zoom})`;
    area.querySelector("#zoom-reset").textContent = `${Math.round(zoom * 100)}%`;
  }
  area.querySelector("#zoom-in").addEventListener("click", () => setZoom(zoom + 0.25));
  area.querySelector("#zoom-out").addEventListener("click", () => setZoom(zoom - 0.25));
  area.querySelector("#zoom-reset").addEventListener("click", () => setZoom(1));
  area.querySelector("#preview-toggle").addEventListener("click", (event) => {
    preview = !preview;
    event.currentTarget.setAttribute("aria-pressed", String(preview));
    shell.classList.toggle("preview-mode", preview);
    selectLayer(selected);
  });
  area.querySelector("#copy-source").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(area.querySelector("#source-editor").value);
      event.target.textContent = "Copied";
    } catch {
      event.target.textContent = "Copy unavailable";
    }
  });
  area.querySelector("#source-file").addEventListener("change", () => tabs.querySelector('[data-mode="code"]').click());
  area.querySelector("#source-editor").addEventListener("change", () => {
    area.querySelector("#draft-state").textContent = "Unsaved changes";
  });
  return { refresh };
}

function input(property, label) {
  return `<label class="property-row">${label}<input data-style="${property}" aria-label="${label}" placeholder="Inherited"></label>`;
}
function select(property, label, values) {
  return `<label class="property-row">${label}<select data-style="${property}" aria-label="${label}">${values.map((value) => `<option value="${escape(value)}">${escape(value || "Default")}</option>`).join("")}</select></label>`;
}
function utilities() {
  const rules = [
    ".mt-4{margin-top:1rem}.mb-4{margin-bottom:1rem}.mx-auto{margin-inline:auto}.text-indigo-700{color:#4338ca}",
    ".flex{display:flex}.inline-flex{display:inline-flex}.grid{display:grid}.items-center{align-items:center}.justify-center{justify-content:center}.flex-col{flex-direction:column}.text-white{color:white}.text-slate-900{color:#0f172a}.bg-blue-600{background:#2563eb}.bg-indigo-600{background:#4f46e5}.bg-slate-900{background:#0f172a}.bg-white{background:white}.rounded-lg{border-radius:8px}.font-medium{font-weight:500}.shadow-md{box-shadow:0 4px 6px #0003}.w-5{width:20px}.h-5{height:20px}",
  ];
  for (const n of [0, 1, 2, 3, 4, 6, 8, 12, 16]) {
    for (const [prefix, properties] of Object.entries({
      p: ["padding"],
      px: ["padding-left", "padding-right"],
      py: ["padding-top", "padding-bottom"],
      m: ["margin"],
      gap: ["gap"],
    })) {
      rules.push(`.${prefix}-${n}{${properties.map((property) => `${property}:${n * 4}px`).join(";")}}`);
    }
  }
  return rules.join("");
}
