const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export const systemUrl = (org) => `/?system=${encodeURIComponent(org)}`;
const projectUrl = (org, repo) => `/?team=${encodeURIComponent(org)}&repo=${encodeURIComponent(repo)}`;

export function initializeNavigation() {
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

export function dashboardHeading(team) {
  const selected = team !== "all";
  document.querySelector("#dashboard-title").textContent = selected ? team : "Design systems";
  document.querySelector("#dashboard-kicker").textContent = selected ? "Team workspace" : "Your workspace";
  document.querySelector("#dashboard-description").textContent = selected
    ? "Your team’s design systems. Each system has its own Foundation and component repositories."
    : "Teams own design systems. Build a shared foundation, then bring your components to life.";
  document.querySelector("#dashboard-breadcrumbs").innerHTML = selected
    ? `<a href="/">Workspace</a><span>/</span><span>${escape(team)}</span>`
    : "<span>Workspace</span>";
  document.querySelector("#systems-title").textContent = selected ? "Design systems" : "All design systems";
}

export async function renderSystemOverview(system, grid) {
  const org = system.org || system.team;
  document.title = `${system.name} · WDS`;
  document.querySelector("#dashboard-title").textContent = system.name;
  document.querySelector("#dashboard-kicker").textContent = "Design system";
  document.querySelector("#dashboard-description").textContent = `Git organization · ${org}`;
  document.querySelector("#dashboard-breadcrumbs").innerHTML =
    `<a href="/">Workspace</a><span>/</span><a href="/?teamSlug=${encodeURIComponent(system.team)}">${escape(system.team)}</a><span>/</span><span>${escape(system.name)}</span>`;
  document.querySelector('.dashboard-heading [data-create="system"]').hidden = true;
  document.querySelector("#systems-title").textContent = "Repositories";
  document.querySelector("#system-summary").textContent = "Foundation + components";
  grid.classList.add("system-overview");
  grid.innerHTML = `<a class="foundation-card" href="${projectUrl(org, system.repo)}"><span class="system-icon">◇</span><div><span class="eyebrow">FOUNDATION</span><h2>Design tokens & shared styles</h2><p>The shared language of your system. Colors, spacing, typography, and reusable styles.</p><code>${escape(org)} / ${escape(system.repo)}</code></div><span class="open-label">Open Foundation →</span></a><div class="section-heading components-heading"><div><h2>Components</h2><p class="section-note">Each component is a repository in this design system.</p></div><button class="primary-button" id="new-component" type="button" disabled>＋ New component</button></div><p id="system-publication" class="publication-note" role="status">Checking published Foundation…</p><div id="overview-components" class="system-grid"><span class="loading">Loading components…</span></div><dialog id="component-dialog" aria-labelledby="component-dialog-title"><button class="dialog-close" type="button" aria-label="Close dialog">×</button><form id="overview-component-form" class="creation-form"><h2 id="component-dialog-title">Create a component</h2><p class="form-description">A new repository in ${escape(org)}, connected to this system’s published Foundation.</p><label for="overview-component-name">Component name</label><input id="overview-component-name" name="name" required maxlength="100" autocomplete="off"><button type="submit">Create component</button><p role="status" id="component-create-status"></p></form></dialog>`;
  const dialog = grid.querySelector("dialog");
  grid.querySelector("#new-component").addEventListener("click", () => dialog.showModal());
  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
  grid.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    const status = grid.querySelector("#component-create-status");
    button.disabled = true;
    try {
      const name = new FormData(event.currentTarget).get("name").trim();
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
      location.href = projectUrl(org, data.repo || repo);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  const components = grid.querySelector("#overview-components");
  const publication = grid.querySelector("#system-publication");
  await Promise.all([
    (async () => {
      try {
        const response = await fetch("/api/projects");
        if (!response.ok) {
          throw new Error("Could not load component repositories. Reload to try again.");
        }
        const projects = (await response.json()).filter((item) => item.team === org && item.type === "component");
        components.innerHTML =
          projects
            .map(
              (item) =>
                `<a class="system-card" href="${projectUrl(org, item.repo)}"><div class="card-top"><span class="system-icon">▱</span><span class="team-tag">Component</span></div><h3>${escape(item.name || item.repo)}</h3><p>${escape(item.description || "A reusable part of your design system.")}</p><span class="card-footer"><code>${escape(item.repo)}</code><span class="open-label">Open studio →</span></span></a>`,
            )
            .join("") ||
          '<div class="empty"><h3>Your first component starts here</h3><p>Publish your Foundation tokens, then create a component to open the design studio.</p></div>';
      } catch (error) {
        components.innerHTML = `<div class="empty">${escape(error.message)}</div>`;
      }
    })(),
    (async () => {
      try {
        const response = await fetch(
          `/static/${encodeURIComponent(org)}/${encodeURIComponent(system.repo)}/latest/tokens.css`,
          { method: "HEAD", cache: "no-store" },
        );
        grid.querySelector("#new-component").disabled = !response.ok;
        publication.innerHTML = response.ok
          ? '<span class="status-dot"></span> Foundation published · Ready to create components'
          : `Publish tokens.css from <a href="${projectUrl(org, system.repo)}">Foundation →</a> to unlock component creation.`;
      } catch {
        publication.textContent = "Could not verify Foundation publication. Reload to try again.";
      }
    })(),
  ]);
}

export function workbenchNavigation(area, project, projects, org, repo) {
  const foundation = project.designSystem?.repo || (project.type === "design-system" ? repo : "foundation");
  const back = document.querySelector(".back-link");
  back.href = systemUrl(org);
  back.innerHTML = "← <span>Design system</span>";
  back.setAttribute("aria-label", "Back to design system");
  const name = document.querySelector("#workspace-name");
  name.innerHTML = `<a href="${systemUrl(org)}">${escape(org)}</a><span> / </span><span>${escape(project.type === "design-system" ? "Foundation" : project.name || repo)}</span>`;
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
        name.innerHTML = `<a href="/?teamSlug=${encodeURIComponent(owner.slug)}">${escape(owner.slug)}</a><span> / </span><a href="${systemUrl(org)}">${escape(system.name)}</a><span> / </span><span>${escape(project.type === "design-system" ? "Foundation" : project.name || repo)}</span>`;
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
    const links = document.createElement("div");
    links.className = "repository-nav";
    links.innerHTML = `<strong>Design system repositories</strong><a href="${projectUrl(org, foundation)}">◇ Foundation</a>${projects
      .filter((item) => item.team === org && item.type === "component")
      .map(
        (item) =>
          `<a href="${projectUrl(org, item.repo)}" ${item.repo === repo ? 'aria-current="page"' : ""}>▱ ${escape(item.name || item.repo)}</a>`,
      )
      .join("")}`;
    navigation.append(links);
  }
}

export function enhanceFoundation(area, source, onEdit) {
  document.querySelector("#workspace").classList.add("foundation-studio");
  area.querySelector(".studio-heading h1").textContent = "Foundation";
  area.querySelector("#save-tokens").textContent = "Save Foundation";
  area.querySelector("#publish-tokens").textContent = "Publish latest";
  area.querySelector("#foundation-styles").hidden = true;
  const components = area.querySelector(".foundation-components");
  const form = area.querySelector("#component-create");
  const createStatus = area.querySelector("#create-status");
  components.querySelector("h2").textContent = "Components";
  components.querySelector("form > p").remove();
  const createButton = document.createElement("button");
  createButton.id = "foundation-new-component";
  createButton.type = "button";
  createButton.textContent = "＋ New component";
  createButton.disabled = true;
  components.querySelector("div").append(createButton);
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "Create a component");
  dialog.innerHTML =
    '<button class="dialog-close" type="button" aria-label="Close dialog">×</button><h2>Create a component</h2>';
  form.classList.add("creation-form");
  dialog.append(form, createStatus);
  components.append(dialog);
  createButton.addEventListener("click", () => dialog.showModal());
  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
  const files = { ...source.files };
  const editor = area.querySelector("#tokens-editor");
  let active = "tokens.css";
  const title = area.querySelector(".foundation-title");
  title.innerHTML =
    '<div><p class="eyebrow">FOUNDATION REPOSITORY</p><h2 id="foundation-tokens">tokens.css</h2><p>Shared source for every component in this system.</p></div>';
  const nav = area.querySelector(".project-nav-content");
  nav.querySelectorAll('a[href^="#foundation-"]').forEach((link) => link.remove());
  const fileList = document.createElement("div");
  fileList.className = "foundation-files";
  fileList.setAttribute("aria-label", "Foundation files");
  nav.querySelector("strong:nth-of-type(2)").after(fileList);
  const saveDraft = () => {
    files[active] = editor.value;
  };
  Object.keys(files).forEach((file) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = file;
    button.setAttribute("aria-pressed", String(file === active));
    button.addEventListener("click", () => {
      saveDraft();
      active = file;
      editor.value = files[file];
      editor.language = file.endsWith(".css")
        ? "css"
        : file.endsWith(".json")
          ? "json"
          : file.endsWith(".html")
            ? "html"
            : "javascript";
      editor.status = file;
      title.querySelector("h2").textContent = file;
      fileList.querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    });
    fileList.append(button);
  });
  editor.addEventListener("change", (event) => {
    files[active] = typeof event.detail === "string" ? event.detail : editor.value;
    onEdit();
  });
  return () => {
    saveDraft();
    return files;
  };
}
