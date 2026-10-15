import "/code-editor.mjs";

const landing = document.querySelector("#landing");
const workspace = document.querySelector("#workspace");
const teamList = document.querySelector("#team-list");
const systemGrid = document.querySelector("#system-grid");
const icon =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m4.5 7.7 7.5 4.4 7.5-4.4M12 12v8.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const arrow =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9m-4-4 4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let systems = [];
let teams = [];
let selectedTeam = "all";
let authenticatedUser = false;
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}
function setUserCard(target, user, authenticated) {
  if (!authenticated) {
    target.innerHTML =
      '<span class="user-avatar">?</span><span class="user-copy"><span class="user-name">Guest</span><span class="user-label">Sign in to browse design systems</span></span><a class="user-action" href="/api/oidc/login">Sign in</a>';
    return;
  }
  const label = user.name || user.preferred_username || user.email || "Signed in";
  const initials =
    label
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "W";
  target.innerHTML = `<span class="user-avatar">${escapeHtml(initials)}</span><span class="user-copy"><span class="user-name">${escapeHtml(label)}</span><span class="user-label">${escapeHtml(user.email || "WDS account")}</span></span><a class="user-action" href="/api/oidc/logout">Sign out</a>`;
}
async function loadUser() {
  let data = {};
  try {
    const response = await fetch("/api/oidc/me", { credentials: "same-origin" });
    if (response.ok) {
      data = await response.json();
    }
  } catch {
    // The account card remains in its signed-out state if session lookup fails.
  }
  for (const card of document.querySelectorAll(".user-card")) {
    setUserCard(card, data.user || {}, data.authenticated === true);
  }
  return data.authenticated === true;
}
function setNotice(message, signIn = false) {
  const notice = document.querySelector("#notice");
  notice.hidden = !message;
  notice.innerHTML = message
    ? `${escapeHtml(message)}${signIn ? ' <a href="/api/oidc/login">Sign in</a> to continue.' : ""}`
    : "";
}
function renderTeams() {
  const availableTeams = [
    ...new Set([
      ...teams.map((team) => (typeof team === "string" ? team : team.slug)),
      ...systems.map((system) => system.team),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  document.querySelector("#team-summary").textContent = availableTeams.length
    ? `${availableTeams.length} ${availableTeams.length === 1 ? "team" : "teams"}`
    : "";
  const buttons = [
    { id: "all", label: "All teams", count: systems.length },
    ...availableTeams.map((team) => ({
      id: team,
      label: team,
      count: systems.filter((system) => system.team === team).length,
    })),
  ];
  const selector = document.querySelector("#system-team");
  if (selector) {
    selector.replaceChildren(...availableTeams.map((item) => new Option(item, item)));
    if (selectedTeam !== "all" && availableTeams.includes(selectedTeam)) {
      selector.value = selectedTeam;
    }
  }
  teamList.innerHTML = buttons.length
    ? buttons
        .map(
          (team) =>
            `<button class="team-button" type="button" data-team="${escapeHtml(team.id)}" aria-pressed="${selectedTeam === team.id}"><span class="team-dot"></span><span>${escapeHtml(team.label)}</span><span class="team-count">${team.count}</span></button>`,
        )
        .join("")
    : '<span class="section-note">Teams will appear here when you have access to a design system.</span>';
  for (const button of teamList.querySelectorAll("[data-team]")) {
    button.addEventListener("click", () => {
      selectedTeam = button.dataset.team;
      renderTeams();
      renderSystems();
    });
  }
}
function renderSystems() {
  const visible = selectedTeam === "all" ? systems : systems.filter((system) => system.team === selectedTeam);
  document.querySelector("#system-summary").textContent =
    `${visible.length} ${visible.length === 1 ? "design system" : "design systems"}`;
  if (!visible.length) {
    systemGrid.innerHTML = `<div class="empty">${systems.length ? "There are no design systems in this team yet." : "No design systems found in these teams yet. Create one above."}</div>`;
    return;
  }
  systemGrid.innerHTML = visible
    .map(
      (system) =>
        `<a class="system-card" href="/?team=${encodeURIComponent(system.org || system.team)}&amp;repo=${encodeURIComponent(system.repo)}" aria-label="Open ${escapeHtml(system.name || system.repo)}"><div class="card-top"><span class="system-icon">${icon}</span><span class="team-tag">${escapeHtml(system.team)}</span></div><h3>${escapeHtml(system.name || system.repo)}</h3><p>${escapeHtml(system.description || "Shared design tokens and component styles.")}</p><span class="card-footer"><span>${escapeHtml(system.repo)}</span><span class="open-label">Open ${arrow}</span></span></a>`,
    )
    .join("");
}
async function loadWorkspace() {
  const authenticated = await loadUser();
  authenticatedUser = authenticated;
  if (!authenticated) {
    landing.hidden = false;
    const authError = new URLSearchParams(location.search).get("auth_error") === "1";
    setNotice(
      authError
        ? "Sign-in could not be completed. Please try again."
        : "Sign in to browse design systems in this workspace.",
      true,
    );
    teamList.innerHTML = '<span class="section-note">Sign in to load teams.</span>';
    systemGrid.innerHTML = '<div class="empty">Your design systems will appear here after sign-in.</div>';
    return;
  }
  document.querySelector("#creation-controls").hidden = false;
  try {
    const [teamsResponse, systemsResponse] = await Promise.all([
      fetch("/api/teams", { credentials: "same-origin" }),
      fetch("/api/design-systems", { credentials: "same-origin" }),
    ]);
    if (teamsResponse.status === 401 || systemsResponse.status === 401) {
      setNotice("Your session has expired.", true);
      return;
    }
    if (!teamsResponse.ok || !systemsResponse.ok) {
      const data = await responseData(teamsResponse.ok ? systemsResponse : teamsResponse);
      setNotice(data.error || "Could not load teams and design systems.");
      teamList.innerHTML = '<span class="section-note">Teams are unavailable.</span>';
      systemGrid.innerHTML = '<div class="empty">Could not load design systems. Please try again.</div>';
      return;
    }
    const teamData = await teamsResponse.json();
    const registered = await systemsResponse.json();
    teams = Array.isArray(teamData.teams) ? teamData.teams : [];
    systems = (registered.designSystems || []).map((system) => ({
      team: teams.find((item) => item.id === system.team_id)?.slug || system.git_org,
      org: system.git_org,
      repo: system.foundation_repo,
      name: system.name,
      type: "design-system",
    }));
    renderTeams();
    renderSystems();
  } catch {
    setNotice("Could not connect to the design-system service.");
    teamList.innerHTML = '<span class="section-note">Teams are unavailable.</span>';
    systemGrid.innerHTML = '<div class="empty">Could not load design systems. Please try again.</div>';
  }
}
async function responseData(response) {
  return response.json().catch(() => ({}));
}
async function refreshWorkspace() {
  const [teamsResponse, systemsResponse] = await Promise.all([
    fetch("/api/teams", { credentials: "same-origin" }),
    fetch("/api/design-systems", { credentials: "same-origin" }),
  ]);
  const teamData = await responseData(teamsResponse);
  const registered = await responseData(systemsResponse);
  if (!teamsResponse.ok || !systemsResponse.ok) {
    throw new Error(teamData.error || registered.error || "Could not refresh teams and design systems.");
  }
  teams = Array.isArray(teamData.teams) ? teamData.teams : [];
  systems = (registered.designSystems || []).map((system) => ({
    team: teams.find((item) => item.id === system.team_id)?.slug || system.git_org,
    org: system.git_org,
    repo: system.foundation_repo,
    name: system.name,
    type: "design-system",
  }));
  renderTeams();
  renderSystems();
}
const teamForm = document.querySelector("#team-form");
teamForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!authenticatedUser) {
    return;
  }
  const button = teamForm.querySelector("button[type=submit]");
  button.disabled = true;
  setNotice("Creating team…");
  try {
    const response = await fetch("/api/teams", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: new FormData(teamForm).get("slug") }),
    });
    const data = await responseData(response);
    if (!response.ok) {
      throw new Error(data.error || `Could not create team (HTTP ${response.status}).`);
    }
    await refreshWorkspace();
    selectedTeam = data.team.slug;
    renderTeams();
    renderSystems();
    teamForm.reset();
    setNotice(`Team ${data.team.slug} created and selected.`);
  } catch (error) {
    setNotice(error.message || "Could not create team.");
  } finally {
    button.disabled = false;
  }
});
const systemForm = document.querySelector("#system-form");
systemForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!authenticatedUser) {
    return;
  }
  const button = systemForm.querySelector("button[type=submit]");
  button.disabled = true;
  setNotice("Creating design system…");
  try {
    const values = Object.fromEntries(new FormData(systemForm));
    const response = await fetch("/api/design-systems", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        team: values.team,
        slug: values.repo,
        gitOrg: values.gitOrg,
        name: values.name || values.repo,
        description: values.description,
        type: "design-system",
      }),
    });
    const data = await responseData(response);
    if (!response.ok) {
      throw new Error(data.error || `Could not create design system (HTTP ${response.status}).`);
    }
    await refreshWorkspace();
    selectedTeam = values.team;
    renderTeams();
    renderSystems();
    systemForm.reset();
    setNotice("Design system created.");
    location.href = `/?team=${encodeURIComponent(data.designSystem.team)}&repo=foundation`;
  } catch (error) {
    setNotice(error.message || "Could not create design system.");
  } finally {
    button.disabled = false;
  }
});
const params = new URLSearchParams(location.search);
const team = params.get("team");
const repo = params.get("repo");
if (team && repo) {
  landing.hidden = true;
  workspace.style.display = "block";
  document.querySelector("#workspace-name").textContent = `${team} / ${repo}`;
  document.title = `${repo} · Workbench`;
  loadWorkbench(team, repo);
} else {
  loadWorkspace();
}

async function loadWorkbench(team, repo) {
  const status = document.querySelector("#work-status");
  const area = document.querySelector("#project-content");
  const user = await loadUser();
  if (!user) {
    status.textContent = "Sign in to open this project.";
    return;
  }
  const projectResponse = await fetch("/api/projects", { credentials: "same-origin" });
  if (!projectResponse.ok) {
    status.textContent =
      projectResponse.status === 401 ? "Your session expired. Sign in again." : "Projects unavailable.";
    return;
  }
  const projects = await projectResponse.json();
  const project = projects.find((item) => item.team === team && item.repo === repo);
  if (!project) {
    status.textContent = "Project not found or unavailable.";
    return;
  }
  const sourceResponse = await fetch(`/api/source/${encodeURIComponent(team)}/${encodeURIComponent(repo)}`, {
    credentials: "same-origin",
  });
  if (!sourceResponse.ok) {
    status.textContent =
      sourceResponse.status === 401 ? "Your session expired. Sign in again." : "Could not load project source.";
    return;
  }
  const source = await sourceResponse.json();
  status.textContent = `${project.type === "component" ? "Team component" : "Design system"} · ${source.revision} · ${source.sourceMode}`;
  if (project.type === "design-system") {
    const components = projects.filter((item) => item.team === team && item.type === "component");
    area.innerHTML = `<div class="studio-heading"><div><p class="studio-kicker">${escapeHtml(team)} / ${escapeHtml(repo)} · Foundation</p><h1>${escapeHtml(project.name || repo)}</h1><p>Tokens and shared styles · tokens must be published before components can be added.</p></div><div class="studio-actions"><span class="state-pill" id="foundation-state">Draft · ${escapeHtml(source.revision)}</span><button type="button" id="save-tokens">Commit</button><button type="button" class="secondary-action" id="publish-tokens">Publish</button></div></div><div class="foundation-layout"><nav class="studio-nav" aria-label="Foundation navigation"><details class="project-drawer" open><summary>Foundation navigation</summary><div class="project-nav-content"><strong>System</strong><a class="nav-context" href="/?team=${encodeURIComponent(team)}&amp;repo=${encodeURIComponent(repo)}">${escapeHtml(project.name || repo)}</a><strong>Foundation files</strong><a href="#foundation-tokens">tokens.css</a><a href="#foundation-styles">styles.css</a><strong>Components</strong><div class="component-list">${components.map((item) => `<a href="/?team=${encodeURIComponent(team)}&amp;repo=${encodeURIComponent(item.repo)}">${escapeHtml(item.name || item.repo)}<small>${escapeHtml(item.repo)}</small></a>`).join("") || "<p>No components yet.</p>"}</div></div></details></nav><section class="foundation-main"><div class="foundation-title"><div><h2 id="foundation-tokens">Tokens</h2><p>Canonical CSS source · commit and publish are separate actions.</p></div><span class="state-pill">tokens.css</span></div><pre class="source-facts" id="foundation-styles"></pre><wds-code-editor id="tokens-editor" role="group" aria-label="Design system tokens"><textarea aria-label="CSS tokens source" spellcheck="false"></textarea></wds-code-editor><div class="action-row"><label>Commit message<input id="tokens-message" value="Update design tokens" maxlength="200"></label></div><p id="token-status" role="status" aria-live="polite"></p><section class="foundation-components"><div><h2>Component projects</h2><p>New components use this system’s published tokens at latest.</p></div><p id="token-publication-state" role="status" aria-live="polite">Checking published tokens…</p><form id="component-create" hidden><label>Component name<input name="name" required maxlength="100" autocomplete="off"></label><p>Available after tokens.css is published.</p><button type="submit">Add component</button></form><p id="create-status" role="status" aria-live="polite"></p></section></section></div>`;
    area.querySelector("#foundation-styles").textContent = source.files["styles.css"] || "(No shared stylesheet yet)";
    const tokensEditor = area.querySelector("#tokens-editor");
    const tokenStatus = area.querySelector("#token-status");
    tokensEditor.value = source.files["tokens.css"] || "";
    area.querySelector(".project-drawer").open = !window.matchMedia("(max-width: 760px)").matches;
    const componentForm = area.querySelector("#component-create");
    const artifactUrl = `/static/${encodeURIComponent(team)}/${encodeURIComponent(repo)}/latest/tokens.css`;
    const probePublishedTokens = async () => {
      componentForm.hidden = true;
      const publicationState = area.querySelector("#token-publication-state");
      try {
        const response = await fetch(artifactUrl, { method: "HEAD", cache: "no-store" });
        componentForm.hidden = !response.ok;
        publicationState.textContent = response.ok
          ? "Published tokens.css is available; component creation is unlocked."
          : "tokens.css is not published yet; publish it to unlock component creation.";
      } catch {
        componentForm.hidden = true;
        publicationState.textContent = "Could not verify token publication; component creation remains locked.";
      }
    };
    probePublishedTokens();
    area.querySelector("#save-tokens").addEventListener("click", async () => {
      const response = await fetch(`/api/source/${encodeURIComponent(team)}/${encodeURIComponent(repo)}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          files: { "tokens.css": tokensEditor.value },
          message: area.querySelector("#tokens-message").value.trim() || "Update design tokens",
        }),
      });
      const data = await responseData(response);
      tokenStatus.textContent = response.ok ? `Committed ${data.revision}.` : data.error || "Could not save tokens.";
      if (response.ok) {
        area.querySelector("#foundation-state").textContent = `Committed · ${data.revision}`;
      }
    });
    area.querySelector("#publish-tokens").addEventListener("click", async () => {
      const response = await fetch(`/api/publish/${encodeURIComponent(team)}/${encodeURIComponent(repo)}`, {
        method: "POST",
        credentials: "same-origin",
      });
      const data = await responseData(response);
      tokenStatus.textContent = response.ok
        ? `Published tokens revision ${data.revision}.`
        : data.error || "Could not publish tokens.";
      if (response.ok) {
        area.querySelector("#foundation-state").textContent = `Published · ${data.revision}`;
        await probePublishedTokens();
      }
    });
    area.querySelector("#component-create").addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const name = values.name.trim();
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, "")
        .slice(0, 100);
      const response = await fetch("/api/projects", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          team,
          repo: slug,
          name,
          type: "component",
          designSystem: { team, repo, revision: "latest" },
        }),
      });
      const data = await responseData(response);
      if (!response.ok) {
        area.querySelector("#create-status").textContent = data.error || "Could not create component.";
        return;
      }
      location.href = `/?team=${encodeURIComponent(team)}&repo=${encodeURIComponent(slug)}`;
    });
    return;
  }
  const files = {
    "component.html":
      source.files["component.html"] ||
      '<template component="ds-component" shadow-dom="open"><div data-wds-editable class="p-4 bg-indigo-600 text-white">Hello component</div></template>',
    "styles.css": source.files["styles.css"] || "",
  };
  if (source.files["component.mjs"] !== undefined) {
    files["component.mjs"] = source.files["component.mjs"];
  }
  area.innerHTML = `<div class="studio-heading"><div><p class="studio-kicker"><a href="/?team=${encodeURIComponent(team)}&amp;repo=${encodeURIComponent(project.designSystem?.repo || "foundation")}">${escapeHtml(project.designSystem?.repo || "Workspace")}</a> / ${escapeHtml(repo)} · Component</p><h1>${escapeHtml(project.name || repo)}</h1><p>Component authoring · canonical source</p></div><div class="studio-actions"><span class="state-pill" id="draft-state">Draft · ${escapeHtml(source.revision)}</span><button type="button" id="history-toggle" aria-expanded="false">History</button><button type="button" id="save-source">Commit</button><button type="button" class="secondary-action" id="publish-source">Publish</button></div></div><div class="studio-shell"><nav class="studio-nav" aria-label="Project navigation"><details class="project-drawer" open><summary>Project & files</summary><div class="project-nav-content"><strong>System</strong><a class="nav-context" href="/?team=${encodeURIComponent(team)}&amp;repo=${encodeURIComponent(project.designSystem?.repo || "foundation")}">${escapeHtml(project.designSystem?.repo || "Design system")}</a><strong>Current component</strong><span class="current-component">${escapeHtml(project.name || repo)}</span><strong>Files</strong><label class="file-label" for="source-file">Select source file</label><select id="source-file" size="${Object.keys(files).length}">${Object.keys(
    files,
  )
    .concat(files["component.mjs"] === undefined ? ["component.mjs"] : [])
    .map(
      (file) =>
        `<option value="${escapeHtml(file)}" ${file === "component.mjs" && files["component.mjs"] === undefined ? "disabled" : ""}>${escapeHtml(file)}</option>`,
    )
    .join(
      "",
    )}</select><label class="module-toggle"><input type="checkbox" id="enable-module" ${files["component.mjs"] !== undefined ? "checked" : ""}> Include component.mjs</label><details class="history-drawer"><summary>History & status</summary><label>Commit message<input id="commit-message" value="Update component source" maxlength="200"></label><p id="save-status" role="status" aria-live="polite"></p><button type="button" id="refresh-history">Refresh history</button><ol id="history-list"></ol><p id="publish-result" role="status" aria-live="polite"></p></details></div></details></nav><main class="authoring-main"><div class="mode-bar"><div role="tablist" aria-label="Authoring mode"><button type="button" class="mode-button active" data-mode="design" role="tab" aria-selected="true">Design</button><button type="button" class="mode-button" data-mode="code" role="tab" aria-selected="false">Code</button></div><label class="viewport-control">Canvas width <input type="range" id="canvas-width" min="320" max="1200" value="760"><output id="canvas-width-label">760 px</output></label></div><section class="design-surface" data-surface="design"><div class="surface-heading"><h2>Design canvas</h2><span class="preview-limit">Draft preview · sandboxed · scripts are not executed</span></div><iframe title="Draft component preview" sandbox="" id="draft-preview"></iframe></section><section class="code-surface" data-surface="code" hidden><div class="surface-heading"><h2>Code · <span id="active-file-label">component.html</span></h2><span>Edits update the canonical draft source.</span></div><wds-code-editor id="source-editor" role="group" aria-label="Component source"><textarea aria-label="Component source" spellcheck="false"></textarea></wds-code-editor></section></main><aside class="studio-inspector"><details class="inspector-drawer" open><summary>Inspector · selected target</summary><div class="inspector-fields"><p>Template root · <code>data-wds-editable</code></p><p id="selected-classes"></p><label>Padding<select data-utility="padding"><option value="">none</option><option>p-2</option><option>p-4</option><option>p-6</option><option>p-8</option></select></label><label>Margin<select data-utility="margin"><option value="">none</option><option>m-2</option><option>m-4</option><option>mt-4</option><option>mb-4</option><option>mx-auto</option></select></label><label>Background<select data-utility="background"><option value="">none</option><option>bg-indigo-600</option><option>bg-blue-600</option><option>bg-slate-900</option><option>bg-white</option></select></label><label>Text color<select data-utility="text"><option value="">none</option><option>text-white</option><option>text-slate-900</option><option>text-indigo-700</option></select></label><label>Custom Tailwind utility<input id="custom-utility" placeholder="rounded-lg" maxlength="80"></label><button type="button" id="apply-utility">Apply utility</button></div></details></aside></div>`;
  area.querySelector("#history-toggle").addEventListener("click", (event) => {
    const navigation = area.querySelector(".project-drawer");
    const history = area.querySelector(".history-drawer");
    navigation.open = true;
    history.open = !history.open;
    event.currentTarget.setAttribute("aria-expanded", String(history.open));
  });
  const setResponsiveDrawers = () => {
    const mobile = window.matchMedia("(max-width: 760px)").matches;
    area.querySelector(".project-drawer").open = !mobile;
    area.querySelector(".inspector-drawer").open = !mobile;
  };
  setResponsiveDrawers();
  window.matchMedia("(max-width: 760px)").addEventListener("change", setResponsiveDrawers);
  const editor = area.querySelector("#source-editor");
  const fileSelect = area.querySelector("#source-file");
  let activeFile = fileSelect.value;
  const updateEditor = ({ saveCurrent = false } = {}) => {
    if (saveCurrent) {
      files[activeFile] = editor.value;
    }
    activeFile = fileSelect.value;
    editor.value = files[fileSelect.value];
    area.querySelector("#active-file-label").textContent = fileSelect.value;
  };
  const modeButtons = [...area.querySelectorAll("[data-mode]")];
  modeButtons.forEach((button) =>
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      modeButtons[(modeButtons.indexOf(button) + direction + modeButtons.length) % modeButtons.length].focus();
    }),
  );
  area.querySelectorAll("[data-mode]").forEach((button) =>
    button.addEventListener("click", () => {
      area.querySelectorAll("[data-mode]").forEach((item) => {
        item.classList.toggle("active", item === button);
        item.setAttribute("aria-selected", String(item === button));
      });
      area.querySelector(".studio-shell").classList.toggle("code-mode", button.dataset.mode === "code");
      area.querySelectorAll("[data-surface]").forEach((surface) => {
        surface.hidden = surface.dataset.surface !== button.dataset.mode;
      });
    }),
  );
  area.querySelector("#canvas-width").addEventListener("input", (event) => {
    const width = Number(event.target.value);
    area.querySelector("#draft-preview").style.width = `min(100%, ${width}px)`;
    area.querySelector("#canvas-width-label").value = `${width} px`;
  });
  const refreshPreview = () => {
    const template = files["component.html"].match(/<template\b[^>]*>([\s\S]*?)<\/template\s*>/i);
    const html = (template?.[1] || files["component.html"])
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<link\b[^>]*rel\s*=\s*(['"])stylesheet\1[^>]*>/gi, "")
      .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, "");
    const utilityPreview =
      ".p-2{padding:.5rem}.p-4{padding:1rem}.p-6{padding:1.5rem}.p-8{padding:2rem}.m-2{margin:.5rem}.m-4{margin:1rem}.mt-4{margin-top:1rem}.mb-4{margin-bottom:1rem}.mx-auto{margin-inline:auto}.bg-indigo-600{background-color:#4f46e5}.bg-blue-600{background-color:#2563eb}.bg-slate-900{background-color:#0f172a}.bg-white{background-color:#fff}.text-white{color:#fff}.text-slate-900{color:#0f172a}.text-indigo-700{color:#4338ca}.rounded-lg{border-radius:.5rem}";
    area.querySelector("#draft-preview").srcdoc =
      `<!doctype html><meta charset="utf-8"><style>${utilityPreview}${files["styles.css"].replace(/@import[^;]+;/g, "").replace(/<\/style/gi, "<\\/style")}</style>${html}`;
    const match = files["component.html"].match(/data-wds-editable[^>]*class\s*=\s*["']([^"']*)/i);
    const classes = match?.[1]?.split(/\s+/).filter(Boolean) || [];
    area.querySelector("#selected-classes").textContent = `Selected classes: ${classes.join(" ") || "(none)"}`;
    const utilityPrefixes = { padding: /^p-/, margin: /^(?:m|mt|mb|mx)-/, background: /^bg-/, text: /^text-/ };
    for (const [group, pattern] of Object.entries(utilityPrefixes)) {
      const select = area.querySelector(`[data-utility="${group}"]`);
      const selected = classes.find((item) => pattern.test(item));
      if (select && [...select.options].some((option) => option.value === selected)) {
        select.value = selected || "";
      }
    }
  };
  fileSelect.addEventListener("change", () => updateEditor({ saveCurrent: true }));
  area.querySelector("#enable-module").addEventListener("change", (event) => {
    if (event.target.checked) {
      files["component.mjs"] = "export const componentName = 'component';\n";
      fileSelect.querySelector('[value="component.mjs"]').disabled = false;
      if (!/component\.mjs/.test(files["component.html"])) {
        files["component.html"] += '\n<script type="module" src="./component.mjs"></script>\n';
      }
    } else {
      delete files["component.mjs"];
      fileSelect.querySelector('[value="component.mjs"]').disabled = true;
      if (fileSelect.value === "component.mjs") {
        fileSelect.value = "component.html";
      }
    }
    updateEditor();
    refreshPreview();
  });
  editor.addEventListener("input", () => {
    files[fileSelect.value] = editor.value;
    refreshPreview();
  });
  area
    .querySelectorAll("[data-utility]")
    .forEach((select) => select.addEventListener("change", () => applyUtility(select.value, select.dataset.utility)));
  function applyUtility(token, group = "custom") {
    if (!token || !/^[a-z0-9-]+(?:\[[a-z0-9#.%_-]+\])?$/.test(token)) {
      return;
    }
    const groupPatterns = {
      padding: /^p-[\w[\].%-]+$/,
      margin: /^(?:m|mt|mb|mx)-[\w[\].%-]+$/,
      background: /^bg-[\w[\].%-]+$/,
      text: /^text-[\w[\].%-]+$/,
    };
    files["component.html"] = files["component.html"].replace(
      /(<[^>]*data-wds-editable[^>]*class\s*=\s*["'])([^"']*)(["'])/i,
      (_all, before, classes, after) => {
        const next = classes
          .split(/\s+/)
          .filter(Boolean)
          .filter((item) => !groupPatterns[group]?.test(item));
        return `${before}${[...new Set([...next, token])].join(" ")}${after}`;
      },
    );
    if (fileSelect.value === "component.html") {
      editor.value = files["component.html"];
    }
    refreshPreview();
  }
  area
    .querySelector("#apply-utility")
    .addEventListener("click", () => applyUtility(area.querySelector("#custom-utility").value.trim()));
  area.querySelector("#save-source").addEventListener("click", async () => {
    files[fileSelect.value] = editor.value;
    const response = await fetch(`/api/source/${encodeURIComponent(team)}/${encodeURIComponent(repo)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files,
        message: area.querySelector("#commit-message").value.trim() || "Update component source",
      }),
    });
    const data = await responseData(response);
    area.querySelector("#save-status").textContent = response.ok
      ? `Committed ${data.revision} (${data.sourceMode}).`
      : data.error || `Save failed (${response.status}).`;
    if (response.ok) {
      area.querySelector("#draft-state").textContent = `Committed · ${data.revision}`;
    }
    if (response.ok) {
      loadHistory();
    }
  });
  async function loadHistory() {
    const response = await fetch(`/api/history/${encodeURIComponent(team)}/${encodeURIComponent(repo)}`, {
      credentials: "same-origin",
    });
    const data = await responseData(response);
    const list = area.querySelector("#history-list");
    list.replaceChildren();
    if (!response.ok) {
      list.textContent = data.error || "History unavailable.";
      return;
    }
    for (const item of data.history || []) {
      const row = document.createElement("li");
      row.textContent = `${item.revision.slice(0, 10)} · ${item.message} · ${item.author} · ${item.date}`;
      list.append(row);
    }
    if (!(data.history || []).length) {
      list.textContent =
        data.sourceMode === "filesystem" ? "Commit history unavailable for mounted source." : "No commits yet.";
    }
  }
  area.querySelector("#refresh-history").addEventListener("click", loadHistory);
  area.querySelector("#publish-source").addEventListener("click", async () => {
    const response = await fetch(`/api/publish/${encodeURIComponent(team)}/${encodeURIComponent(repo)}`, {
      method: "POST",
      credentials: "same-origin",
    });
    const data = await responseData(response);
    const result = area.querySelector("#publish-result");
    result.textContent = response.ok
      ? `Published revision ${data.revision}. `
      : data.error || `Publish failed (${response.status}).`;
    if (response.ok) {
      area.querySelector("#draft-state").textContent = `Published · ${data.revision}`;
      const preview = document.createElement("a");
      preview.href = `/static/${encodeURIComponent(team)}/${encodeURIComponent(repo)}/latest/component.html?view=component`;
      preview.target = "_blank";
      preview.rel = "noopener";
      preview.textContent = "Open published component preview";
      const artifactPath = document.createElement("code");
      artifactPath.textContent = `/static/${team}/${repo}/latest/component.html`;
      result.append(preview, document.createTextNode(" · "), artifactPath);
    }
  });
  updateEditor();
  refreshPreview();
  loadHistory();
}
