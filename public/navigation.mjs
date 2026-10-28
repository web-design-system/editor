const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export const systemUrl = (org) => `/?system=${encodeURIComponent(org)}`;
const projectUrl = (org, repo) => `/?team=${encodeURIComponent(org)}&repo=${encodeURIComponent(repo)}`;

export function initializeNavigation() {
  document.querySelector("#system-filter").addEventListener("input", filterRepositories);
  const mobile = window.matchMedia("(max-width: 760px)");
  const drawer = document.querySelector(".team-drawer");
  drawer.open = !mobile.matches;
  mobile.addEventListener("change", () => {
    drawer.open = !mobile.matches;
  });
  const dialog = document.querySelector("#creation-dialog");
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-create]");
    if (!trigger) {
      return;
    }
    const kind = trigger.dataset.create;
    document.querySelector("#team-form").hidden = kind !== "team";
    document.querySelector("#system-form").hidden = kind !== "system";
    document.querySelector("#creation-status").textContent = "";
    dialog.setAttribute("aria-label", kind === "team" ? "Create a team" : "Create a design system");
    if (!dialog.open) {
      dialog.showModal();
    }
    dialog.querySelector("form:not([hidden]) input, form:not([hidden]) select")?.focus();
  });
  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
}

export function filterRepositories() {
  const query = document.querySelector("#system-filter").value.trim().toLowerCase();
  const rows = [...document.querySelectorAll("#system-grid .system-card")];
  rows.forEach((row) => {
    row.hidden = !(row.dataset.search || row.textContent).toLowerCase().includes(query);
  });
  const empty =
    document.querySelector("#system-grid.system-overview #filter-empty") || document.querySelector("#filter-empty");
  empty.hidden = !query || !rows.length || rows.some((row) => !row.hidden);
}

export function dashboardHeading(team) {
  const grid = document.querySelector("#system-grid");
  grid.before(document.querySelector(".list-toolbar"));
  const filter = document.querySelector("#system-filter");
  filter.placeholder = "Find a system…";
  filter.setAttribute("aria-label", "Find a system");
  const selected = team !== "all";
  document.querySelector("#dashboard-title").textContent = selected ? team : "";
  document.querySelector("#system-settings-link").hidden = true;
  document.querySelector("#dashboard-title").hidden = !selected;
  document.querySelector("#dashboard-breadcrumbs").hidden = !selected;
  document.querySelector("#dashboard-breadcrumbs").innerHTML = selected ? '<a href="/">← All teams</a>' : "";
  document.querySelector("#systems-title").textContent = selected ? "Design systems" : "All design systems";
}

function renderSystemSidebar(system, org, projects) {
  const sidebar = document.querySelector("#team-list");
  const teamSlug = system.team || org;
  document.querySelector("#team-navigation-label").textContent = system.name;
  document.querySelector("#teams-title").textContent = "Components";
  document.querySelector("#team-summary").textContent = `${projects.length}`;
  sidebar.innerHTML = `<a class="mb-2 block rounded px-2 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-blue-400" href="/?teamSlug=${encodeURIComponent(teamSlug)}">← Back to systems</a><div class="mb-2 px-2 text-xs font-semibold text-zinc-100">${escape(system.name)}</div>${
    projects
      .map(
        (item) =>
          `<a class="block rounded px-2 py-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-blue-400" href="${projectUrl(org, item.repo)}">${escape(item.name || item.repo)}</a>`,
      )
      .join("") || '<span class="px-2 text-xs text-zinc-500">No components yet.</span>'
  }`;
}

export async function renderSystemOverview(system, grid) {
  grid.before(document.querySelector(".list-toolbar"));
  const org = system.org || system.team;
  document.title = `${system.name} · WDS`;
  document.querySelector("#dashboard-title").textContent = system.name;
  const settingsLink = document.querySelector("#system-settings-link");
  settingsLink.href = projectUrl(system.org || system.team, system.repo);
  settingsLink.hidden = false;
  document.querySelector("#dashboard-title").hidden = false;
  document.querySelector("#dashboard-breadcrumbs").hidden = false;
  document.querySelector("#dashboard-breadcrumbs").innerHTML = '<a href="/">← All design systems</a>';
  document.querySelector('.dashboard-heading [data-create="system"]').hidden = true;
  document.querySelector("#systems-title").textContent = "Repositories";
  document.querySelector("#system-summary").textContent = "";
  grid.classList.add("system-overview");
  grid.classList.add("flex", "flex-col", "gap-0");
  grid.innerHTML = `<span id="system-publication" class="sr-only" role="status">Checking Foundation publication…</span><section id="foundation-setup" class="foundation-setup mt-[18px] max-w-[760px] rounded-[5px] border border-zinc-700 bg-gradient-to-br from-zinc-900 to-[#141417] p-5 sm:px-[22px]" hidden><span class="eyebrow mb-[9px] block text-[10px] font-semibold tracking-[.12em] text-blue-400">FIRST, SET UP FOUNDATION</span><h2 class="m-0 text-base font-medium tracking-[-.02em] text-zinc-100">Give every component the same design language.</h2><p class="max-w-[620px] text-xs leading-[1.7] text-zinc-400">Foundation holds the shared design tokens—CSS variables for color, spacing, and type. Components use these variables to stay consistent and update together.</p><a class="setup-action mt-1 inline-flex items-center gap-2.5 rounded border border-blue-500 bg-blue-500/10 px-[11px] py-2 text-xs font-medium text-blue-200 hover:bg-blue-500/20">Open Foundation <span aria-hidden="true">→</span></a><p class="setup-footnote mb-0 mt-3 text-[11px] text-zinc-400">Add your values to <code class="font-mono text-[11px] text-zinc-300">tokens.css</code>, save, then publish. You can create components once the published tokens are ready.</p></section><section id="component-area" class="component-area" hidden><div class="section-heading components-heading my-5 flex items-center justify-between gap-3"><h2 class="text-sm font-medium text-zinc-100">Components <span id="component-count" class="ml-1.5 text-zinc-500"></span></h2></div><div class="component-toolbar mb-2.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 sm:gap-2"><div class="component-search"></div><button class="primary-button min-h-9 rounded border border-zinc-100 bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 hover:bg-white" id="new-component" type="button">＋ New component</button></div><wds-data-list id="overview-components" class="system-grid grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Components"></wds-data-list><p id="filter-empty" class="empty m-0 rounded border border-dashed border-zinc-700 bg-zinc-900/50 p-5 text-left text-xs text-zinc-400" hidden>No matches.</p></section><dialog id="component-dialog" class="fixed inset-0 m-auto max-h-[calc(100dvh-48px)] w-[min(480px,calc(100%-32px))] overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 p-7 text-zinc-300 shadow-[0_24px_80px_#0008] backdrop:bg-[#09090bcc] backdrop:backdrop-blur" aria-labelledby="component-dialog-title"><button class="dialog-close absolute right-3 top-2.5 h-7 w-7 border-0 bg-transparent text-[22px] text-zinc-400" type="button" aria-label="Close dialog">×</button><form id="overview-component-form" class="creation-form grid gap-2.5 border-0 bg-transparent p-0"><h2 class="m-0 text-xl font-medium tracking-[-.03em] text-zinc-100" id="component-dialog-title">Create a component</h2><p class="form-description mb-3 mt-0 text-xs leading-[1.7] text-zinc-400">A new repository in ${escape(org)}, connected to this system’s published Foundation.</p><label class="text-xs text-zinc-400" for="overview-component-name">Component name</label><input class="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-[9px] text-[13px] text-zinc-200" id="overview-component-name" name="name" required maxlength="100" autocomplete="off"><button class="mt-2 justify-self-stretch rounded border border-zinc-100 bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 hover:bg-white" type="submit">Create component</button><p role="status" class="text-xs leading-[1.6] text-zinc-400" id="component-create-status"></p></form></dialog>`;
  const dialog = grid.querySelector("dialog");
  const createComponentButton = grid.querySelector("#new-component");
  createComponentButton.classList.add(
    "h-9",
    "rounded-sm",
    "border",
    "border-zinc-100",
    "bg-zinc-100",
    "px-3",
    "py-0",
    "text-xs",
    "font-medium",
    "text-zinc-900",
    "hover:bg-white",
  );
  const filter = document.querySelector("#system-filter");
  filter.value = "";
  filter.placeholder = "Find a component…";
  filter.setAttribute("aria-label", "Find a component");
  filter.parentElement.classList.remove("mb-2.5");
  grid.querySelector(".component-search").append(filter.parentElement);
  grid.querySelector("#new-component").addEventListener("click", () => dialog.showModal());
  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
  const createComponent = async (name, status, button) => {
    const buttonLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Creating…";
    status.textContent = "";
    try {
      const repo = name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, "")
        .slice(0, 100);
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          team: org,
          repo,
          name,
          type: "component",
          designSystem: { team: org, repo: system.repo, revision: "latest" },
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not create component.");
      }
      window.dispatchEvent(new CustomEvent("wds:navigate", { detail: projectUrl(org, data.repo || repo) }));
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = buttonLabel;
    }
  };
  grid.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    const status = grid.querySelector("#component-create-status");
    const name = new FormData(event.currentTarget).get("name").trim();
    createComponent(name, status, button);
  });
  const components = grid.querySelector("#overview-components");
  components.className = "system-grid grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3";
  const componentArea = grid.querySelector("#component-area");
  const setup = grid.querySelector("#foundation-setup");
  setup.className =
    "foundation-setup mx-auto grid min-h-[calc(100dvh-80px)] w-[min(560px,calc(100%-36px))] content-center justify-items-center py-12 text-center";
  setup.insertAdjacentHTML(
    "afterbegin",
    '<svg class="mb-8 h-40 w-48" viewBox="0 0 192 160" fill="none" aria-hidden="true"><circle cx="96" cy="82" r="70" fill="#2563EB" fill-opacity=".08"/><path d="M48 52.5 96 34l48 18.5v56L96 127l-48-18.5v-56Z" fill="#18181B" stroke="#3F3F46"/><path d="m49 53 47 18 47-18M96 72v54" stroke="#52525B" stroke-linejoin="round"/><rect x="63" y="54" width="66" height="39" rx="5" fill="#27272A" stroke="#52525B"/><rect x="72" y="64" width="28" height="5" rx="2.5" fill="#60A5FA"/><rect x="72" y="75" width="46" height="4" rx="2" fill="#71717A"/><rect x="72" y="84" width="34" height="4" rx="2" fill="#52525B"/><circle cx="132" cy="41" r="10" fill="#2563EB" fill-opacity=".2"/><path d="M132 36v10m-5-5h10" stroke="#93C5FD" stroke-linecap="round" stroke-width="1.5"/></svg>',
  );
  const setupEyebrow = setup.querySelector(".eyebrow");
  setupEyebrow.className = "mb-2 text-[10px] font-semibold uppercase tracking-[.16em] text-blue-400";
  setupEyebrow.textContent = "YOUR DESIGN SYSTEM FOUNDATION";
  const setupTitle = setup.querySelector("h2");
  setupTitle.className = "m-0 text-2xl font-semibold tracking-[-.04em] text-zinc-100";
  setupTitle.textContent = "Define your design tokens";
  const setupDescription = setup.querySelector("p");
  setupDescription.className = "mt-3 max-w-[390px] text-sm leading-6 text-zinc-400";
  setupDescription.textContent =
    "Give your design system the foundation it needs: the colors, spacing, or any tokens used by all components.";
  const setupAction = setup.querySelector(".setup-action");
  setupAction.href = projectUrl(org, system.repo);
  setupAction.className =
    "setup-action mt-7 inline-flex h-11 items-center gap-2 rounded border border-blue-400 bg-blue-500 px-5 text-sm font-medium text-white transition-colors hover:bg-blue-400";
  setupAction.innerHTML = 'Create Design Foundation <span aria-hidden="true">→</span>';
  setup.querySelector(".setup-footnote")?.remove();
  const setupStatus = document.createElement("p");
  setupStatus.className = "mt-3 text-xs text-red-300";
  setupStatus.setAttribute("role", "status");
  setupStatus.hidden = true;
  setup.append(setupStatus);
  const publication = grid.querySelector("#system-publication");
  try {
    const published = await fetch(
      `/static/${encodeURIComponent(org)}/${encodeURIComponent(system.repo)}/latest/tokens.css`,
      { method: "HEAD", cache: "no-store" },
    );
    if (!publication.isConnected) {
      return;
    }
    publication.innerHTML = published.ok ? '<span class="status-dot"></span> Published' : "Not published";
    componentArea.hidden = !published.ok;
    setup.hidden = published.ok;
    if (!published.ok) {
      const response = await fetch("/api/projects");
      if (response.ok) {
        const projects = (await response.json()).filter((item) => item.team === org && item.type === "component");
        renderSystemSidebar(system, org, projects);
      }
      return;
    }
    const response = await fetch("/api/projects");
    if (!response.ok) {
      throw new Error("Could not load component repositories. Reload to try again.");
    }
    const projects = (await response.json()).filter((item) => item.team === org && item.type === "component");
    if (!components.isConnected) {
      return;
    }
    renderSystemSidebar(system, org, projects);
    grid.querySelector("#component-count").textContent = projects.length;
    if (!projects.length) {
      componentArea.querySelector(".components-heading").hidden = true;
      componentArea.querySelector(".component-toolbar").hidden = true;
      components.className = "component-empty-container";
      components.innerHTML = `<section class="mx-auto grid min-h-[calc(100dvh-320px)] w-[min(560px,100%)] content-center justify-items-center py-12 text-center" aria-labelledby="first-component-title"><svg class="mb-8 h-40 w-48" viewBox="0 0 192 160" fill="none" aria-hidden="true"><circle cx="96" cy="82" r="70" fill="#2563EB" fill-opacity=".08"/><path d="M48 52.5 96 34l48 18.5v56L96 127l-48-18.5v-56Z" fill="#18181B" stroke="#3F3F46"/><path d="m49 53 47 18 47-18M96 72v54" stroke="#52525B" stroke-linejoin="round"/><rect x="63" y="54" width="66" height="39" rx="5" fill="#27272A" stroke="#52525B"/><rect x="72" y="64" width="28" height="5" rx="2.5" fill="#60A5FA"/><rect x="72" y="75" width="46" height="4" rx="2" fill="#71717A"/><rect x="72" y="84" width="34" height="4" rx="2" fill="#52525B"/><circle cx="132" cy="41" r="10" fill="#2563EB" fill-opacity=".2"/><path d="M132 36v10m-5-5h10" stroke="#93C5FD" stroke-linecap="round" stroke-width="1.5"/></svg><p class="mb-2 text-[10px] font-semibold uppercase tracking-[.16em] text-blue-400">FIRST COMPONENT</p><h2 class="m-0 text-2xl font-semibold tracking-[-.04em] text-zinc-100" id="first-component-title">Create your first component</h2><p class="mt-3 max-w-[390px] text-sm leading-6 text-zinc-400">Give your design system its first reusable building block. Start with a name and make it yours.</p><form class="mt-7 flex w-full max-w-[420px] gap-2" id="first-component-form"><label class="sr-only" for="first-component-name">Component name</label><input class="h-11 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-blue-400" id="first-component-name" name="name" placeholder="Component name" maxlength="100" autocomplete="off" required><button class="h-11 shrink-0 rounded border border-blue-400 bg-blue-500 px-5 text-sm font-medium text-white transition-colors hover:bg-blue-400 disabled:cursor-wait disabled:opacity-60" type="submit">Create</button></form><p class="mt-3 min-h-5 text-xs text-red-300" id="first-component-status" role="status" aria-live="polite"></p></section>`;
      components.querySelector("#first-component-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('[type="submit"]');
        const status = components.querySelector("#first-component-status");
        const name = new FormData(event.currentTarget).get("name").trim();
        createComponent(name, status, button);
      });
    } else if (typeof components.render === "function") {
      components.render(
        projects,
        (project) => {
          const name = project.name || project.repo;
          const card = document.createElement("a");
          card.href = projectUrl(org, project.repo);
          card.className =
            "system-card flex min-h-40 flex-col rounded-2xl border border-zinc-800 bg-zinc-900 p-5 hover:border-blue-400 hover:bg-zinc-800";
          card.dataset.search = `${name} ${project.description || ""}`.toLowerCase();
          const icon = document.createElement("span");
          icon.className =
            "mb-5 grid size-10 place-items-center rounded-xl border border-blue-500/20 bg-blue-500/10 text-xl text-blue-300";
          icon.textContent = "▱";
          const title = document.createElement("h3");
          title.className = "m-0 text-base font-semibold text-zinc-100";
          title.textContent = name;
          const description = document.createElement("p");
          description.className = "mt-1 text-xs text-zinc-400";
          description.textContent = project.description || "Component";
          const version = document.createElement("span");
          version.className = "mt-auto pt-5 text-xs text-zinc-400";
          version.textContent = `Latest version: ${project.version || project.latestVersion || "—"}`;
          card.append(icon, title, description, version);
          return card;
        },
        "No components yet.",
      );
    } else {
      components.innerHTML = projects
        .map(
          (item) =>
            `<a class="system-card repository-row flex min-h-[60px] flex-nowrap items-center gap-3 border border-zinc-800 bg-zinc-900 p-3 transition-colors hover:bg-[#202024]" href="${projectUrl(org, item.repo)}"><span class="system-icon grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[5px] border border-zinc-700 bg-zinc-800 text-zinc-400">▱</span><div class="repository-copy min-w-0 flex-1"><h3 class="m-0 text-[13px] font-medium leading-[1.4] [overflow-wrap:anywhere] text-zinc-100">${escape(item.name || item.repo)}</h3>${item.description ? `<span class="repository-description mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-zinc-400">${escape(item.description)}</span>` : ""}</div><span class="row-arrow shrink-0 text-base text-zinc-500" aria-hidden="true">→</span></a>`,
        )
        .join("");
    }
    filterRepositories();
  } catch {
    if (!publication.isConnected) {
      return;
    }
    publication.textContent = "Could not check";
    componentArea.hidden = true;
    setup.hidden = false;
    setupStatus.textContent = "Couldn’t check whether Foundation is published. Try reloading.";
    setupStatus.hidden = false;
  }
}

export function workbenchNavigation(area, project, projects, org, repo) {
  const foundation = project.designSystem?.repo || (project.type === "design-system" ? repo : "foundation");
  const name = document.querySelector("#workspace-name");
  const crumb = `<span class="truncate">${escape(project.designSystem?.name || org)}</span><span aria-hidden="true">/</span><span class="truncate">${escape(project.type === "design-system" ? "Foundation" : project.name || repo)}</span>`;
  name.innerHTML = crumb;
  Promise.all([fetch("/api/teams"), fetch("/api/design-systems")])
    .then(async ([teamResponse, systemResponse]) => {
      if (!teamResponse.ok || !systemResponse.ok) {
        return;
      }
      const { teams = [] } = await teamResponse.json();
      const { designSystems = [] } = await systemResponse.json();
      const system = designSystems.find((item) => item.git_org === org);
      const owner = teams.find((item) => item.id === system?.team_id);
      if (system && owner) {
        name.innerHTML = `<span class="truncate">${escape(system.name)}</span><span aria-hidden="true">/</span><span class="truncate">${escape(project.type === "design-system" ? "Foundation" : project.name || repo)}</span>`;
        area.querySelector(".component-hierarchy h2")?.replaceChildren(system.name);
      }
    })
    .catch(() => {
      /* Repository navigation remains available during metadata outages. */
    });
  const navigation = area.querySelector(".project-nav-content");
  const context = navigation?.querySelector(".nav-context");
  if (context) {
    context.href = systemUrl(org);
    context.textContent = org;
  }
  if (project.type === "component" && navigation) {
    const hierarchy = document.createElement("section");
    hierarchy.className = "component-hierarchy mb-3 flex flex-col gap-2 border-b border-zinc-800 px-3 pb-3";
    hierarchy.innerHTML = `<a class="text-xs text-zinc-400 hover:text-blue-400" href="${systemUrl(org)}">← Back to systems</a><h2 class="mt-1 truncate text-xs font-semibold text-zinc-100">${escape(project.designSystem?.name || org)}</h2><strong class="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Components</strong><div class="hierarchy-components flex flex-col gap-1">${projects
      .filter((item) => item.team === org && item.type === "component")
      .map(
        (item) =>
          `<a class="block rounded px-2 py-1.5 text-xs text-zinc-400 hover:bg-blue-500/10 hover:text-blue-400 aria-[current=page]:bg-blue-500/10 aria-[current=page]:text-blue-400" href="${projectUrl(org, item.repo)}" ${item.repo === repo ? 'aria-current="page"' : ""}>${escape(item.name || item.repo)}</a>`,
      )
      .join("")}</div>`;
    area.querySelector(".project-drawer").before(hierarchy);
    const links = document.createElement("div");
    links.className = "repository-nav border-t border-zinc-800 pt-3";
    links.innerHTML = `<a class="block rounded px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800" href="${projectUrl(org, foundation)}">◇ Foundation</a>`;
    navigation.prepend(links);
    navigation.querySelector(".nav-context")?.remove();
    area.querySelector(".project-drawer > summary").textContent = "Project files";
  }
}

export function enhanceFoundation(area, source, onEdit) {
  document.querySelector("#workspace").classList.add("foundation-studio");
  area.querySelector(".studio-heading h1").textContent = "Foundation";
  area.querySelector("#save-tokens").textContent = "Save Foundation";
  area.querySelector("#publish-tokens").textContent = "Publish latest";
  const components = area.querySelector(".foundation-components");
  const form = area.querySelector("#component-create");
  const createStatus = area.querySelector("#create-status");
  area.querySelector(".project-drawer").classList.remove("border-t", "pt-3");
  area.querySelector(".project-nav-content").classList.remove("border-t", "pt-3");
  area.querySelector(".nav-context").classList.remove("bg-indigo-950", "text-indigo-200", "rounded-md");
  area.querySelector(".nav-context").classList.add("rounded", "bg-zinc-800", "text-zinc-300", "text-xs");
  area.querySelectorAll(".component-list > a").forEach((link) => {
    link.classList.remove(
      "rounded-lg",
      "border",
      "border-slate-700",
      "p-2",
      "text-sm",
      "font-medium",
      "text-slate-200",
      "hover:border-indigo-400",
      "hover:bg-slate-800",
    );
    link.classList.add("block", "rounded", "px-2.5", "py-2", "text-xs", "text-zinc-400", "hover:bg-zinc-800");
    link.querySelector("small")?.classList.add("mt-1", "block", "text-[10px]", "text-zinc-500");
  });
  components
    .querySelector("div")
    .classList.add(
      "flex",
      "items-center",
      "justify-between",
      "gap-3",
      "max-[760px]:items-start",
      "max-[760px]:flex-col",
    );
  area
    .querySelector("#token-publication-state")
    .classList.add("rounded", "border", "border-zinc-800", "bg-zinc-900", "px-3", "py-2", "text-xs", "text-zinc-400");
  components.querySelector("h2").textContent = "Components";
  components.querySelector("form > p").remove();
  const createButton = document.createElement("button");
  createButton.id = "foundation-new-component";
  createButton.type = "button";
  createButton.textContent = "＋ New component";
  createButton.disabled = true;
  createButton.classList.add(
    "min-h-[30px]",
    "rounded",
    "bg-zinc-100",
    "px-3",
    "py-1.5",
    "text-xs",
    "font-medium",
    "text-zinc-900",
    "hover:bg-white",
    "disabled:opacity-30",
  );
  components.querySelector("div").append(createButton);
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "Create a component");
  dialog.className =
    "fixed inset-0 m-auto max-h-[calc(100%-3rem)] w-[min(480px,calc(100%-2rem))] overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 p-7 text-zinc-300 shadow-2xl backdrop:bg-zinc-950/80";
  dialog.innerHTML =
    '<button class="dialog-close absolute right-3 top-2.5 h-7 w-7 border-0 bg-transparent p-0 text-[22px] text-zinc-400" type="button" aria-label="Close dialog">×</button><h2 class="mb-5 text-xl font-medium tracking-tight text-zinc-100">Create a component</h2>';
  form.classList.add("creation-form", "grid", "gap-2.5", "border-0", "bg-transparent", "p-0");
  dialog.append(form, createStatus);
  components.append(dialog);
  createButton.addEventListener("click", () => dialog.showModal());
  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
  const files = {
    "tokens.css": source.files["tokens.css"] || "",
    "reset.css": source.files["reset.css"] ?? source.files["styles.css"] ?? "",
  };
  // Foundation files are canonical and always present, even for older repositories.
  files["tokens.css"] ??= "";
  files["reset.css"] ??= "";
  const editor = area.querySelector("#tokens-editor");
  let active = "tokens.css";
  editor.value = source.files[active] || "";
  const originalFiles = { ...files, "tokens.css": editor.value };
  files["tokens.css"] = editor.value;
  let deleteFiles = source.files["styles.css"] && !source.files["reset.css"] ? ["styles.css"] : [];
  const title = area.querySelector(".foundation-title");
  title.innerHTML =
    '<div><p class="eyebrow text-[10px] font-semibold tracking-[0.12em] text-zinc-500">FOUNDATION REPOSITORY</p><h2 class="font-mono text-base font-normal" id="foundation-tokens">tokens.css</h2><p class="text-xs leading-relaxed text-zinc-400">Shared source for every component in this system.</p></div>';
  const nav = area.querySelector(".project-nav-content");
  nav.querySelectorAll('a[href^="#foundation-"]').forEach((link) => link.remove());
  const fileList = document.createElement("div");
  fileList.className = "foundation-files flex flex-col gap-1";
  fileList.setAttribute("aria-label", "Foundation files");
  nav.append(fileList);
  const saveDraft = () => {
    files[active] = editor.value;
  };
  const saveButton = area.querySelector("#save-tokens");
  const updateSaveButton = () => {
    saveDraft();
    saveButton.disabled = !draft.isDirty();
  };
  saveButton.disabled = true;
  Object.keys(files).forEach((file) => {
    const button = document.createElement("button");
    button.className =
      "min-h-[30px] rounded px-2.5 py-1.5 text-left text-xs font-normal text-zinc-400 aria-pressed:bg-blue-500/10 aria-pressed:text-blue-400";
    button.type = "button";
    button.textContent = file;
    button.setAttribute("aria-label", file);
    button.setAttribute("aria-pressed", String(file === active));
    button.addEventListener("click", () => {
      saveDraft();
      active = file;
      editor.value = files[file];
      updateSaveButton();
      editor.language = file.endsWith(".css")
        ? "css"
        : file.endsWith(".json")
          ? "json"
          : file.endsWith(".html")
            ? "html"
            : "javascript";
      editor.status = file;
      title.querySelector("h2").textContent = file;
      title.querySelector("h2").id = file === "reset.css" ? "foundation-reset" : "foundation-tokens";
      fileList.querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    });
    fileList.append(button);
  });
  editor.addEventListener("input", () => {
    files[active] = editor.value;
    onEdit();
    updateSaveButton();
  });
  editor.addEventListener("change", (event) => {
    files[active] = typeof event.detail === "string" ? event.detail : editor.value;
    onEdit();
    updateSaveButton();
  });
  const draft = () => {
    saveDraft();
    return files;
  };
  draft.isDirty = () =>
    deleteFiles.length > 0 || Object.keys(files).some((file) => files[file] !== originalFiles[file]);
  draft.deleteFiles = deleteFiles;
  draft.markSaved = (savedFiles) => {
    Object.assign(originalFiles, savedFiles);
    deleteFiles = [];
    draft.deleteFiles = deleteFiles;
    updateSaveButton();
  };
  if (deleteFiles.length) {
    onEdit();
  }
  return draft;
}
