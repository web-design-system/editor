const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const selectedLayerClasses = [
  "!outline-2",
  "!outline-blue-500",
  "!outline-offset-[6px]",
  "relative",
  "after:absolute",
  "after:bottom-[calc(100%+8px)]",
  "after:left-[-8px]",
  "after:rounded-sm",
  "after:bg-blue-500",
  "after:px-1.5",
  "after:py-0.5",
  "after:text-[10px]",
  "after:font-sans",
  "after:text-white",
  "after:whitespace-nowrap",
  "after:pointer-events-none",
  "after:content-[attr(data-studio-label)]",
];

const tailwindScales = [
  "0",
  "px",
  "0.5",
  "1",
  "1.5",
  "2",
  "2.5",
  "3",
  "3.5",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "14",
  "16",
  "20",
  "24",
  "28",
  "32",
  "36",
  "40",
  "44",
  "48",
  "52",
  "56",
  "60",
  "64",
  "72",
  "80",
  "96",
  "auto",
  "full",
  "screen",
  "min",
  "max",
  "fit",
];
const tailwindVariants = [
  "hover",
  "focus",
  "focus-visible",
  "active",
  "disabled",
  "checked",
  "first",
  "last",
  "odd",
  "even",
  "group-hover",
  "group-focus",
  "peer-checked",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl",
  "dark",
];

function tailwindBaseCandidates(styles = "") {
  const candidates = new Set([
    "sr-only",
    "not-sr-only",
    "container",
    "static",
    "fixed",
    "absolute",
    "relative",
    "sticky",
    "visible",
    "invisible",
    "collapse",
    "block",
    "inline-block",
    "inline",
    "flex",
    "inline-flex",
    "table",
    "grid",
    "inline-grid",
    "hidden",
    "flow-root",
    "contents",
    "list-item",
    "flex-row",
    "flex-row-reverse",
    "flex-col",
    "flex-col-reverse",
    "flex-wrap",
    "flex-nowrap",
    "flex-1",
    "flex-auto",
    "flex-initial",
    "flex-none",
    "grow",
    "shrink",
    "grow-0",
    "shrink-0",
    "items-start",
    "items-end",
    "items-center",
    "items-baseline",
    "items-stretch",
    "justify-start",
    "justify-end",
    "justify-center",
    "justify-between",
    "justify-around",
    "justify-evenly",
    "self-start",
    "self-end",
    "self-center",
    "self-stretch",
    "place-items-center",
    "place-content-center",
    "overflow-auto",
    "overflow-hidden",
    "overflow-visible",
    "overflow-scroll",
    "truncate",
    "text-left",
    "text-center",
    "text-right",
    "text-justify",
    "font-sans",
    "font-serif",
    "font-mono",
    "font-thin",
    "font-light",
    "font-normal",
    "font-medium",
    "font-semibold",
    "font-bold",
    "font-extrabold",
    "italic",
    "not-italic",
    "uppercase",
    "lowercase",
    "capitalize",
    "normal-case",
    "underline",
    "overline",
    "line-through",
    "no-underline",
    "antialiased",
    "subpixel-antialiased",
    "whitespace-normal",
    "whitespace-nowrap",
    "break-words",
    "break-all",
    "rounded",
    "rounded-none",
    "rounded-sm",
    "rounded-md",
    "rounded-lg",
    "rounded-xl",
    "rounded-2xl",
    "rounded-full",
    "shadow",
    "shadow-sm",
    "shadow-md",
    "shadow-lg",
    "shadow-xl",
    "shadow-none",
    "border",
    "border-0",
    "border-2",
    "border-4",
    "border-dashed",
    "border-solid",
    "border-none",
    "outline-none",
    "cursor-pointer",
    "cursor-default",
    "pointer-events-none",
    "select-none",
    "object-cover",
    "object-contain",
    "aspect-square",
    "aspect-video",
    "list-none",
    "list-disc",
    "list-decimal",
    "decoration-2",
    "transition",
    "transition-all",
    "transition-colors",
    "duration-150",
    "duration-300",
    "ease-in",
    "ease-out",
    "ease-in-out",
    "animate-spin",
    "animate-ping",
    "animate-pulse",
    "animate-bounce",
    "whitespace-pre",
  ]);
  const spacingFamilies = [
    "p",
    "px",
    "py",
    "ps",
    "pe",
    "pt",
    "pr",
    "pb",
    "pl",
    "m",
    "mx",
    "my",
    "ms",
    "me",
    "mt",
    "mr",
    "mb",
    "ml",
    "gap",
    "gap-x",
    "gap-y",
    "space-x",
    "space-y",
    "scroll-m",
    "scroll-p",
    "top",
    "right",
    "bottom",
    "left",
    "inset",
    "inset-x",
    "inset-y",
    "w",
    "min-w",
    "max-w",
    "h",
    "min-h",
    "max-h",
    "size",
    "basis",
    "translate-x",
    "translate-y",
    "-translate-x",
    "-translate-y",
  ];
  for (const family of spacingFamilies) {
    for (const scale of tailwindScales) {
      candidates.add(`${family}-${scale}`);
    }
  }
  for (let columns = 1; columns <= 12; columns++) {
    candidates.add(`grid-cols-${columns}`);
    candidates.add(`grid-rows-${columns}`);
    candidates.add(`col-span-${columns}`);
  }
  for (const value of ["0", "5", "10", "15", "20", "25", "30", "40", "50", "60", "70", "75", "80", "90", "95", "100"]) {
    candidates.add(`opacity-${value}`);
    candidates.add(`z-${value}`);
    candidates.add(`order-${value}`);
    candidates.add(`rotate-${value}`);
  }
  for (const value of ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"]) {
    candidates.add(`text-${value}`);
    candidates.add(`leading-${value}`);
  }
  for (const value of ["none", "tight", "snug", "normal", "relaxed", "loose"]) {
    candidates.add(`leading-${value}`);
    candidates.add(`tracking-${value}`);
  }
  const colors = new Set([
    "inherit",
    "current",
    "transparent",
    "black",
    "white",
    "slate",
    "gray",
    "zinc",
    "neutral",
    "stone",
    "red",
    "orange",
    "amber",
    "yellow",
    "lime",
    "green",
    "emerald",
    "teal",
    "cyan",
    "sky",
    "blue",
    "indigo",
    "violet",
    "purple",
    "fuchsia",
    "pink",
    "rose",
  ]);
  const themeColors = new Set();
  for (const [, color] of styles.matchAll(/--color-([a-z0-9-]+)\s*:/gi)) {
    themeColors.add(color);
  }
  const colorFamilies = [
    "bg",
    "text",
    "border",
    "ring",
    "outline",
    "decoration",
    "placeholder",
    "fill",
    "stroke",
    "accent",
    "caret",
  ];
  const shades = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
  for (const family of colorFamilies) {
    for (const color of themeColors) {
      candidates.add(`${family}-${color}`);
    }
    for (const color of colors) {
      if (["inherit", "current", "transparent", "black", "white"].includes(color)) {
        candidates.add(`${family}-${color}`);
        continue;
      }
      for (const shade of shades) {
        candidates.add(`${family}-${color}-${shade}`);
      }
    }
  }
  return [...candidates];
}

// The studio edits the same draft object used by source commits and the code editor.
export function createStudio(area, files, onEdit) {
  const workspace = document.querySelector("#workspace");
  const workArea = document.querySelector("#work-area");
  workspace.classList.add(
    "design-studio",
    "relative",
    "h-dvh",
    "overflow-hidden",
    "bg-zinc-950",
    "text-zinc-300",
    "[color-scheme:dark]",
    "max-[760px]:h-auto",
    "max-[760px]:min-h-dvh",
    "max-[760px]:overflow-auto",
  );
  document.querySelector("#app-topbar")?.classList.add("h-14", "gap-4", "bg-zinc-900", "px-4");
  document.querySelector(".brand-mark")?.classList.add("size-8", "rounded");
  document.querySelector(".workspace-name")?.classList.add("mr-auto", "text-zinc-200");
  workArea.classList.remove("p-6", "min-h-[calc(100dvh-56px)]");
  workArea.classList.add("h-[calc(100dvh-56px)]", "min-h-0", "bg-zinc-950", "p-0", "max-[760px]:h-auto");
  document.querySelector("#work-status").classList.add("hidden");
  area.classList.add("flex", "h-full", "min-h-0", "flex-col", "max-[760px]:h-auto");
  const shell = area.querySelector(".studio-shell");
  shell.classList.remove("mx-auto", "max-w-screen-2xl", "min-h-[650px]", "rounded-xl");
  shell.classList.add("h-full", "min-h-0", "w-full", "rounded-none");
  const nav = area.querySelector(".studio-nav");
  nav.setAttribute("aria-label", "Layers");
  const inspector = area.querySelector(".studio-inspector");
  const canvas = area.querySelector(".design-surface");
  const frame = area.querySelector("#draft-preview");
  const code = area.querySelector(".code-surface");
  const tabs = area.querySelector('[role="tablist"]');
  const fields = area.querySelector(".inspector-fields");
  const navToggle = document.querySelector(".editor-nav-toggle");
  navToggle?.classList.remove("hidden");
  const overlay = document.createElement("button");
  overlay.type = "button";
  overlay.className = "mobile-nav-overlay";
  overlay.setAttribute("aria-label", "Close layers");
  shell.prepend(overlay);
  nav.classList.add("editor-sidebar");
  area.querySelectorAll("button, input, select, summary").forEach((control) => {
    control.classList.add(
      "focus-visible:outline-2",
      "focus-visible:outline-blue-400",
      "focus-visible:outline-offset-2",
    );
  });
  shell.classList.add(
    "flex-1",
    "w-full",
    "max-w-none",
    "m-0",
    "grid-cols-[256px_minmax(0,1fr)_320px]",
    "border-0",
    "rounded-none",
    "bg-zinc-950",
    "min-h-0",
    "max-[1100px]:grid-cols-[200px_minmax(0,1fr)_280px]",
    "max-[760px]:flex",
    "max-[760px]:flex-col",
  );
  shell.classList.remove("lg:grid-cols-[205px_minmax(0,1fr)_235px]");
  area
    .querySelector(".studio-heading")
    .classList.add(
      "flex",
      "shrink-0",
      "min-h-14",
      "h-14",
      "max-w-none",
      "m-0",
      "items-center",
      "justify-between",
      "gap-3",
      "border-b",
      "border-zinc-800",
      "bg-zinc-900",
      "px-4",
      "py-2",
      "max-[1100px]:static",
    );
  area.querySelector(".studio-heading > div:first-child").classList.add("min-w-0", "max-[1100px]:block");
  area
    .querySelector(".studio-heading")
    .classList.add(
      "min-[1101px]:absolute",
      "min-[1101px]:right-20",
      "min-[1101px]:top-0",
      "min-[1101px]:z-10",
      "min-[1101px]:h-14",
      "min-[1101px]:border-0",
      "min-[1101px]:bg-transparent",
      "min-[1101px]:p-0",
      "max-[760px]:h-auto",
      "max-[760px]:items-stretch",
      "max-[760px]:flex-col",
    );
  area.querySelector(".studio-heading > div:first-child").classList.add("min-[1101px]:hidden");
  area.querySelector(".studio-heading h1").classList.add("text-sm", "font-medium", "text-zinc-50", "tracking-normal");
  area.querySelectorAll(".studio-heading p").forEach((paragraph) => paragraph.classList.add("hidden"));
  area.querySelector(".studio-actions").prepend(tabs);
  code.querySelector("code-editor").classList.add("h-full", "min-h-0");
  code.querySelector("code-editor").style.height = "100%";
  area.querySelector(".studio-actions").classList.add("gap-2", "max-[760px]:justify-start", "max-[760px]:flex-wrap");
  nav.classList.add("min-h-0", "overflow-auto", "bg-zinc-900", "p-0", "gap-0", "max-[760px]:max-h-[220px]");
  inspector.classList.add(
    "min-h-0",
    "overflow-auto",
    "bg-zinc-900",
    "p-0",
    "gap-0",
    "flex",
    "flex-col",
    "border-l",
    "border-zinc-800",
    "max-[760px]:border-l-0",
  );
  area
    .querySelector(".authoring-main")
    .classList.add("min-h-0", "p-0", "border-0", "flex", "flex-col", "overflow-hidden", "max-[760px]:min-h-[400px]");
  nav.setAttribute("aria-label", "Layers");
  area.querySelector(".inspector-drawer > summary").classList.add("px-4", "py-3", "text-zinc-400", "font-medium");
  tabs.classList.add("flex", "shrink-0", "border-b", "border-zinc-800");
  tabs.querySelectorAll("button").forEach((button) => {
    button.classList.add(
      "flex-1",
      "rounded-none",
      "px-3",
      "py-3",
      "border-b-2",
      "border-transparent",
      "text-zinc-400",
      "aria-selected:text-zinc-50",
      "aria-selected:border-blue-500",
    );
    button.classList.remove("aria-selected:bg-indigo-50", "aria-selected:text-indigo-800");
    button.classList.add("aria-selected:bg-zinc-800");
  });
  area
    .querySelector(".studio-actions")
    .querySelectorAll("button")
    .forEach((button) =>
      button.classList.add(
        "min-h-7",
        "rounded",
        "bg-transparent",
        "px-2.5",
        "py-1",
        "text-xs",
        "font-medium",
        "text-zinc-400",
        "hover:bg-zinc-800",
        "hover:text-zinc-50",
      ),
    );
  area.querySelector("#save-source").classList.add("bg-zinc-100", "text-zinc-900");
  area
    .querySelector(".mode-bar")
    .classList.add("order-2", "px-4", "py-2", "border-t", "border-zinc-800", "bg-zinc-900", "min-h-[37px]");
  area.querySelector(".mode-bar").remove();
  canvas.classList.add(
    "relative",
    "flex-1",
    "min-h-0",
    "flex",
    "items-center",
    "justify-center",
    "overflow-hidden",
    "bg-[radial-gradient(#27272a_1px,transparent_1px)]",
    "[background-size:16px_16px]",
  );
  frame.classList.add(
    "border-0",
    "bg-transparent",
    "w-full",
    "h-full",
    "min-h-0",
    "shrink-0",
    "max-w-[760px]",
    "[transform-origin:center]",
    "[background:transparent]",
    "max-[760px]:h-[350px]",
  );
  code.classList.add("flex-1", "min-h-0", "bg-[#1e1e1e]");
  nav.insertAdjacentHTML(
    "afterbegin",
    '<div class="panel-title flex items-center justify-between border-b border-zinc-800 px-3 py-3.5 text-xs font-semibold uppercase tracking-[0.08em] text-zinc-100">Layers <span title="Select a layer to edit">◇</span></div><div id="layer-list" aria-label="Component layers" class="min-h-[120px] flex-1 overflow-auto p-2"></div>',
  );
  area.querySelector(".inspector-drawer > summary").textContent = "Selected element";
  area.querySelector(".inspector-drawer").open = true;
  fields.classList.add("p-0", "gap-0");
  fields.innerHTML = `<p id="selected-element" class="px-4 pb-3 text-blue-400 font-mono"></p><section class="property-section border-t border-zinc-800 p-4"><h2 class="mb-3.5 text-[11px] tracking-[0.08em] text-zinc-100">Layout</h2>${select("display", "Display", ["", "block", "flex", "inline-flex", "grid", "inline-block", "none"])}${select("flex-direction", "Direction", ["", "row", "column", "row-reverse", "column-reverse"])}${select("align-items", "Align", ["", "flex-start", "center", "flex-end", "stretch"])}${select("justify-content", "Justify", ["", "flex-start", "center", "flex-end", "space-between"])}</section><section class="property-section border-t border-zinc-800 p-4"><h2 class="mb-3.5 text-[11px] tracking-[0.08em] text-zinc-100">Spacing</h2><div class="spacing-fields grid grid-cols-2 gap-4 text-[10px] text-zinc-400"><div><span>Padding</span><div class="padding-grid mt-1.5 grid grid-cols-3 gap-1">${["top", "left", "right", "bottom"].map((side) => `<input aria-label="Padding ${side}" data-style="padding-${side}" placeholder="auto" title="CSS length, e.g. 12px" class="px-0 py-1 text-center text-[10px]">`).join("")}<span class="col-start-2 row-start-2 place-self-center text-lg">□</span></div></div><label>Gap<input data-style="gap" placeholder="normal"></label></div>${input("margin", "Margin")}</section><section class="property-section border-t border-zinc-800 p-4"><h2 class="mb-3.5 text-[11px] tracking-[0.08em] text-zinc-100">Colors</h2>${input("background-color", "Background")}${input("color", "Text")}</section><section class="property-section border-t border-zinc-800 p-4"><h2 class="mb-3.5 text-[11px] tracking-[0.08em] text-zinc-100">Effects</h2>${input("border-radius", "Radius")}${select("box-shadow", "Shadow", ["", "none", "0 1px 2px #0003", "0 4px 6px #0003", "0 10px 15px #0003"])}<label class="property-row mt-2 grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2 text-xs text-zinc-400">Opacity<input aria-label="Opacity" data-style="opacity" type="range" min="0" max="1" step="0.05" value="1" class="accent-blue-500"></label></section><section class="property-section border-t border-zinc-800 p-4"><h2 class="mb-3.5 text-[11px] tracking-[0.08em] text-zinc-100">Element</h2><div class="grid gap-2"><p class="m-0 text-xs text-zinc-400">Classes</p><div id="class-tags" class="flex flex-wrap gap-1.5" aria-label="Element classes"></div><label class="grid gap-1 text-xs text-zinc-400">Add a Tailwind class<input id="class-input" role="combobox" aria-label="Add a Tailwind class" aria-autocomplete="list" aria-controls="class-suggestions" aria-expanded="false" autocomplete="off" placeholder="Search classes…" class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"></label><div id="class-suggestions" class="max-h-48 overflow-auto rounded border border-zinc-700 bg-zinc-900 p-1" role="listbox" hidden></div><p id="style-status" role="status" class="m-0 text-xs text-rose-400"></p></div></section>`;
  fields.querySelectorAll(":scope > section:first-of-type select[data-style]").forEach((select) => {
    const options = [...select.options].map((option) => option.value).filter(Boolean);
    const values = select.dataset.style === "display" ? ["flex", "inline", "block", "grid"] : options;
    const group = document.createElement("div");
    group.className = "property-toggle flex flex-wrap gap-1";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", select.getAttribute("aria-label"));
    for (const value of values) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.style = select.dataset.style;
      button.dataset.value = value;
      button.setAttribute("aria-pressed", "false");
      button.className =
        "rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:border-blue-400 aria-pressed:border-blue-500 aria-pressed:bg-blue-500/15 aria-pressed:text-blue-300 disabled:opacity-40";
      button.textContent = value;
      group.append(button);
    }
    select.replaceWith(group);
  });
  fields.querySelectorAll(":scope > section.property-section").forEach((section) => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.className = "cursor-pointer py-2 text-sm font-medium text-zinc-200";
    summary.textContent = section.querySelector("h2")?.textContent || "Properties";
    details.className = "property-section border-t border-zinc-800 px-4 py-3";
    details.open = true;
    section.querySelector("h2")?.remove();
    details.append(summary, ...section.childNodes);
    section.replaceWith(details);
  });
  canvas.querySelector(".surface-heading").remove();
  canvas.insertAdjacentHTML(
    "afterbegin",
    '<div class="canvas-tools absolute right-4 top-4 z-10 flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 p-1 shadow-lg"><button type="button" id="zoom-out" aria-label="Zoom out">−</button><button type="button" id="zoom-reset" aria-label="Reset zoom">100%</button><button type="button" id="zoom-in" aria-label="Zoom in">+</button></div>',
  );
  area.querySelector("#save-source").textContent = "Save Component";
  code.querySelector(".surface-heading").innerHTML =
    '<span id="active-file-label">component.html</span><button type="button" id="copy-source">Copy</button>';
  let selected = 0;
  let foundationTokens = "";
  let zoom = 1;
  let preview = false;
  let holder;
  let nodes = [];
  let candidateCache = null;
  let highlightedSuggestion = 0;
  const list = area.querySelector("#layer-list");
  const classTags = area.querySelector("#class-tags");
  const classInput = area.querySelector("#class-input");
  const classSuggestions = area.querySelector("#class-suggestions");
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
  function getClassCandidates() {
    if (!candidateCache) {
      candidateCache = tailwindBaseCandidates(`${files["styles.css"] || ""}\n${foundationTokens}`);
    }
    return candidateCache;
  }
  function renderClassTags(element) {
    classTags.replaceChildren();
    classInput.value = "";
    classInput.disabled = !element;
    for (const className of element?.classList || []) {
      const tag = document.createElement("span");
      tag.className =
        "inline-flex max-w-full items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 font-mono text-[10px] leading-none text-zinc-200";
      const text = document.createElement("span");
      text.className = "max-w-[170px] overflow-hidden text-ellipsis whitespace-nowrap";
      text.textContent = className;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className =
        "ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-white";
      remove.setAttribute("aria-label", `Remove ${className}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        const node = nodes[selected];
        if (!node) {
          return;
        }
        const remaining = [...node.classList].filter((value) => value !== className);
        if (remaining.length) {
          node.setAttribute("class", remaining.join(" "));
        } else {
          node.removeAttribute("class");
        }
        write();
      });
      tag.append(text, remove);
      classTags.append(tag);
    }
    renderClassSuggestions();
  }
  function renderClassSuggestions() {
    const query = classInput.value.trim();
    const used = new Set(nodes[selected]?.classList || []);
    const candidates = getClassCandidates();
    let matches;
    if (!query) {
      matches = [];
    } else if (query.includes(":")) {
      const lastColon = query.lastIndexOf(":");
      const modifiers = query.slice(0, lastColon).split(":");
      const prefix = query.slice(0, lastColon + 1);
      const fragment = query.slice(lastColon + 1);
      matches = modifiers.every((modifier) => tailwindVariants.includes(modifier))
        ? candidates.filter((candidate) => candidate.startsWith(fragment)).map((candidate) => `${prefix}${candidate}`)
        : [];
    } else {
      matches = candidates.filter((candidate) => candidate.startsWith(query));
      for (const variant of tailwindVariants) {
        if (`${variant}:`.startsWith(query)) {
          matches.unshift(`${variant}:`);
        }
      }
    }
    matches = [...new Set(matches)].filter((candidate) => candidate && !used.has(candidate)).slice(0, 40);
    classSuggestions.replaceChildren();
    highlightedSuggestion = 0;
    for (const [index, candidate] of matches.entries()) {
      const option = document.createElement("button");
      option.type = "button";
      option.role = "option";
      option.dataset.className = candidate;
      option.setAttribute("aria-selected", String(index === highlightedSuggestion));
      option.className =
        "block w-full rounded px-2 py-1.5 text-left font-mono text-[11px] text-zinc-300 hover:bg-zinc-800 aria-selected:bg-blue-500/15 aria-selected:text-blue-200";
      option.textContent = candidate;
      classSuggestions.append(option);
    }
    classSuggestions.hidden = matches.length === 0;
    classInput.setAttribute("aria-expanded", String(matches.length > 0));
  }
  function addClassNames(value) {
    const node = nodes[selected];
    const additions = value.trim().split(/\s+/).filter(Boolean);
    if (!node || !additions.length) {
      return;
    }
    const merged = [...new Set([...node.classList, ...additions])];
    node.setAttribute("class", merged.join(" "));
    classInput.value = "";
    write();
    classInput.focus();
  }
  classInput.addEventListener("input", renderClassSuggestions);
  classInput.addEventListener("keydown", (event) => {
    const options = [...classSuggestions.querySelectorAll('[role="option"]')];
    if (event.key === "ArrowDown" && options.length) {
      event.preventDefault();
      highlightedSuggestion = (highlightedSuggestion + 1) % options.length;
      options.forEach((option, index) => {
        option.setAttribute("aria-selected", String(index === highlightedSuggestion));
      });
      options[highlightedSuggestion].scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowUp" && options.length) {
      event.preventDefault();
      highlightedSuggestion = (highlightedSuggestion + options.length - 1) % options.length;
      options.forEach((option, index) => {
        option.setAttribute("aria-selected", String(index === highlightedSuggestion));
      });
      options[highlightedSuggestion].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      addClassNames(options[highlightedSuggestion]?.dataset.className || classInput.value);
    } else if (event.key === "Escape") {
      classSuggestions.hidden = true;
      classInput.setAttribute("aria-expanded", "false");
    }
  });
  classSuggestions.addEventListener("click", (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) {
      addClassNames(option.dataset.className);
    }
  });
  function selectLayer(index) {
    selected = index;
    list.querySelectorAll("button").forEach((button, i) => button.setAttribute("aria-pressed", String(i === selected)));
    const element = nodes[selected];
    area.querySelector("#selected-element").textContent = element ? element.localName : "No elements in this template";
    renderClassTags(element);
    const rendered = frame.contentDocument?.querySelector(`[data-studio-node="${selected}"]`);
    frame.contentDocument?.querySelectorAll("[data-studio-selected]").forEach((el) => {
      el.removeAttribute("data-studio-selected");
      el.classList.remove(...selectedLayerClasses);
    });
    if (rendered && !preview) {
      rendered.setAttribute("data-studio-selected", "");
      rendered.classList.add(...selectedLayerClasses);
    }
    const computed = rendered ? frame.contentWindow.getComputedStyle(rendered) : null;
    fields.querySelectorAll("[data-style]").forEach((control) => {
      control.disabled = !element;
      const value =
        element?.style.getPropertyValue(control.dataset.style) ||
        computed?.getPropertyValue(control.dataset.style) ||
        "";
      if (control.tagName === "BUTTON") {
        control.setAttribute("aria-pressed", String(control.dataset.value === value));
      } else if (control.tagName === "SELECT") {
        control.value = [...control.options].some((option) => option.value === value) ? value : "";
      } else {
        control.value = value;
      }
    });
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
      button.className =
        "mb-1 block w-full overflow-hidden text-ellipsis whitespace-nowrap rounded px-2 py-1.5 text-left text-[13px] text-zinc-400 hover:bg-zinc-800 aria-pressed:bg-blue-500/10 aria-pressed:text-blue-400";
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
    let tokenStylesheet = foundationTokens
      ? `<style>${foundationTokens.replace(/<\/style/gi, "<\\/style")}</style>`
      : "";
    try {
      const dependency = JSON.parse(files["component.json"] || "{}").designSystem;
      if (!foundationTokens && dependency?.team && dependency?.repo) {
        const revision = dependency.revision || "latest";
        tokenStylesheet = `<link rel="stylesheet" href="/static/${encodeURIComponent(dependency.team)}/${encodeURIComponent(dependency.repo)}/${encodeURIComponent(revision)}/tokens.css">`;
      }
    } catch {
      tokenStylesheet = "";
    }
    frame.srcdoc = `<!doctype html><html class="min-h-full bg-zinc-950"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; img-src data: https:; font-src data:; form-action 'none'">${tokenStylesheet}<link rel="stylesheet" href="/css/tailwind.css"><style>${css}\nhtml,body{background-color:#09090b!important}</style></head><body class="m-0 flex min-h-dvh items-center justify-center bg-zinc-950 bg-[radial-gradient(#27272a_1px,transparent_1px)] [background-size:16px_16px] p-10 text-sm text-[#d4d4d8]">${container.innerHTML}</body></html>`;
    selectLayer(selected);
  }
  try {
    const dependency = JSON.parse(files["component.json"] || "{}").designSystem;
    if (dependency?.team && dependency?.repo) {
      const sourceURL = `/api/source/${encodeURIComponent(dependency.team)}/${encodeURIComponent(dependency.repo)}`;
      fetch(sourceURL, { credentials: "same-origin" })
        .then((response) => (response.ok ? response.json() : null))
        .then((source) => {
          if (typeof source?.files?.["tokens.css"] === "string") {
            foundationTokens = source.files["tokens.css"];
            candidateCache = null;
            refresh();
          }
        })
        .catch(() => {});
    }
  } catch {
    // Keep the published-token fallback for projects with incomplete metadata.
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
  fields.querySelectorAll("[data-style]:not(button)").forEach((control) =>
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
  fields.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-style][data-value]");
    const node = nodes[selected];
    if (!button || !node) {
      return;
    }
    node.style.setProperty(button.dataset.style, button.dataset.value);
    area.querySelector("#style-status").textContent = "";
    write();
  });
  function setZoom(value) {
    zoom = Math.max(0.25, Math.min(2, value));
    frame.style.transform = `scale(${zoom})`;
    area.querySelector("#zoom-reset").textContent = `${Math.round(zoom * 100)}%`;
  }
  area.querySelector("#zoom-in").addEventListener("click", () => setZoom(zoom + 0.25));
  area.querySelector("#zoom-out").addEventListener("click", () => setZoom(zoom - 0.25));
  area.querySelector("#zoom-reset").addEventListener("click", () => setZoom(1));
  area.querySelector("#copy-source").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(area.querySelector("#source-editor").value);
      event.target.textContent = "Copied";
    } catch {
      event.target.textContent = "Copy unavailable";
    }
  });
  return { refresh };
}

function input(property, label) {
  return `<label class="property-row mt-2 grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2 text-xs text-zinc-400">${label}<input data-style="${property}" aria-label="${label}" placeholder="Inherited" class="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300"></label>`;
}
function select(property, label, values) {
  return `<label class="property-row mt-2 grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2 text-xs text-zinc-400">${label}<select data-style="${property}" aria-label="${label}" class="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300">${values.map((value) => `<option value="${escape(value)}">${escape(value || "Default")}</option>`).join("")}</select></label>`;
}
