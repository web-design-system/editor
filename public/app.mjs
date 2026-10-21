import { createStudio } from "./studio.mjs";
import { registerEditorFallback } from "./editor-fallback.mjs";
import { createRepositoryCard, createTeamItem, initializeUiComponents } from "./ui-components.mjs";
import {
  initializeNavigation,
  filterRepositories,
  dashboardHeading,
  renderSystemOverview,
  workbenchNavigation,
  enhanceFoundation,
  systemUrl,
} from "./navigation.mjs";
initializeNavigation();
let uiComponentsReady = false;
const uiComponentsLoad = Promise.race([
  initializeUiComponents(),
  new Promise((resolve) => window.setTimeout(() => resolve(false), 2000)),
]).then((ready) => {
  uiComponentsReady = ready;
  return ready;
});

const landing = document.querySelector("#landing");
const workspace = document.querySelector("#workspace");
const teamList = document.querySelector("#team-list");
const systemGrid = document.querySelector("#system-grid");
let codeEditorLoad;
async function loadCodeEditor() {
  if (!codeEditorLoad) {
    codeEditorLoad = (async () => {
      const { load } = await import("@li3/web");
      await load("https://sodium.static.apphor.de/code-editor.html");
      await customElements.whenDefined("code-editor");
    })().catch(() => {
      registerEditorFallback();
    });
  }
  await codeEditorLoad;
}
const icon =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m4.5 7.7 7.5 4.4 7.5-4.4M12 12v8.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const arrow =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9m-4-4 4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let systems = [];
let teams = [];
let systemsLoaded = false;
let selectedTeam = new URLSearchParams(location.search).get("teamSlug") || "all";
let authenticatedUser = false;
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}
function setUserCard(target, user, authenticated) {
  if (!authenticated) {
    target.hidden = true;
    return;
  }
  target.hidden = false;
  const label = user.name || user.preferred_username || user.email || "Signed in";
  const initials =
    label
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "W";
  const studio = target.closest("#workspace")?.classList.contains("design-studio");
  target.innerHTML = `<span class="user-avatar ${studio ? "hidden" : "inline-flex size-9 max-[560px]:size-7"} shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-medium text-zinc-400">${escapeHtml(initials)}</span><span class="user-copy ${studio ? "hidden" : "flex"} min-w-0 flex-col"><span class="user-name truncate font-semibold">${escapeHtml(label)}</span><span class="user-label truncate text-xs text-zinc-500 max-[560px]:hidden">${escapeHtml(user.email || "WDS account")}</span></span><a class="user-action shrink-0 text-sm font-semibold text-blue-400 hover:underline max-[560px]:text-xs" href="/api/oidc/logout">Sign out</a>`;
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
  document.querySelector("#creation-status").textContent = message || "";
  const notice = document.querySelector("#notice");
  notice.hidden = !message;
  notice.innerHTML = message
    ? `${escapeHtml(message)}${signIn ? ' <a class="font-semibold text-blue-400 hover:underline" href="/api/oidc/login">Sign in</a> to continue.' : ""}`
    : "";
}
function showGuestWelcome(message, footnote) {
  landing.hidden = false;
  workspace.classList.add("hidden");
  const dashboardLayout = document.querySelector("#dashboard-layout");
  document.querySelector("#dashboard-content").hidden = false;
  document.querySelector("#first-system-empty").hidden = true;
  dashboardLayout.hidden = true;
  dashboardLayout.setAttribute("aria-busy", "false");
  document.querySelector("#guest-welcome").hidden = false;
  const error = document.querySelector("#welcome-error");
  error.textContent = message;
  error.hidden = !message;
  document.querySelector("#welcome-footnote").textContent = footnote;
  document.querySelector("#welcome-footnote").hidden = !footnote;
}
function renderTeams() {
  document.querySelector("#team-navigation-label").textContent = selectedTeam === "all" ? "All teams" : selectedTeam;
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
  if (buttons.length && uiComponentsReady) {
    teamList.replaceChildren(
      ...buttons.map((team) =>
        createTeamItem({ id: team.id, label: team.label, count: team.count, selected: selectedTeam === team.id }),
      ),
    );
  } else {
    teamList.innerHTML = buttons.length
      ? buttons
          .map(
            (team) =>
              `<button class="team-button flex w-full items-center gap-2 rounded px-2 py-2 text-left text-[13px] text-zinc-300 hover:bg-zinc-800 aria-pressed:bg-blue-500/10 aria-pressed:text-blue-400" type="button" data-team="${escapeHtml(team.id)}" aria-pressed="${selectedTeam === team.id}"><span class="team-dot size-1.5 shrink-0 rounded-full bg-zinc-500"></span><span class="min-w-0 flex-1 truncate">${escapeHtml(team.label)}</span><span class="team-count text-[11px] text-zinc-500">${team.count}</span></button>`,
          )
          .join("")
      : '<span class="section-note text-sm text-zinc-500">Teams will appear here when you have access to a design system.</span>';
  }
  for (const button of teamList.querySelectorAll("[data-team]")) {
    button.addEventListener("click", () => {
      if (new URLSearchParams(location.search).has("system")) {
        location.href = button.dataset.team === "all" ? "/" : `/?teamSlug=${encodeURIComponent(button.dataset.team)}`;
        return;
      }
      selectedTeam = button.dataset.team;
      if (window.matchMedia("(max-width: 760px)").matches) {
        document.querySelector(".team-drawer").open = false;
      }
      history.replaceState(null, "", selectedTeam === "all" ? "/" : `/?teamSlug=${encodeURIComponent(selectedTeam)}`);
      renderTeams();
      renderSystems();
    });
  }
}
function renderSystems() {
  systemGrid.classList.add("flex", "flex-col", "gap-0");
  document.querySelector("#system-filter").value = "";
  document.querySelector("#filter-empty").hidden = true;
  const emptyState = document.querySelector("#first-system-empty");
  const dashboardContent = document.querySelector("#dashboard-content");
  const dashboardLayout = document.querySelector("#dashboard-layout");
  emptyState.hidden = true;
  dashboardContent.hidden = false;
  dashboardLayout.hidden = false;
  const org = new URLSearchParams(location.search).get("system");
  if (org) {
    const system = systems.find((item) => (item.org || item.team) === org);
    if (system) {
      renderSystemOverview(system, systemGrid);
    } else {
      systemGrid.innerHTML =
        '<div class="empty rounded border border-dashed border-zinc-700 bg-zinc-900/50 p-5 text-left text-xs text-zinc-400">Design system not found. <a class="font-semibold text-blue-400 hover:underline" href="/">Return to workspace →</a></div>';
    }
    return;
  }
  dashboardHeading(selectedTeam);
  const visible = selectedTeam === "all" ? systems : systems.filter((system) => system.team === selectedTeam);
  document.querySelector("#system-summary").textContent = "";
  if (!visible.length) {
    const availableTeams = teams.map((team) => (typeof team === "string" ? team : team.slug));
    if (systemsLoaded && availableTeams.length > 0) {
      dashboardContent.hidden = true;
      emptyState.hidden = false;
      return;
    }
    systemGrid.innerHTML =
      '<div class="empty rounded border border-dashed border-zinc-700 bg-zinc-900/50 p-5 text-left text-xs text-zinc-400">No systems yet.</div>';
    return;
  }
  if (uiComponentsReady) {
    systemGrid.replaceChildren(
      ...visible.map((system) =>
        createRepositoryCard({
          href: systemUrl(system.org || system.team),
          name: system.name || system.repo,
          description: system.description,
          team: selectedTeam === "all" ? system.team : "",
          icon: "▱",
          accessibleName: `Open ${system.name || system.repo}`,
          className: "system-card",
        }),
      ),
    );
  } else {
    systemGrid.innerHTML = visible
      .map(
        (system) =>
          `<a class="system-card repository-row flex min-h-[60px] min-w-0 items-center gap-3 rounded-[5px] border border-zinc-800 bg-zinc-900 p-3 text-left transition-colors hover:bg-[#202024]" href="${systemUrl(system.org || system.team)}" aria-label="Open ${escapeHtml(system.name || system.repo)}"><span class="system-icon flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[5px] border border-zinc-700 bg-zinc-800 text-lg text-zinc-400">${icon}</span><div class="repository-copy min-w-0 flex-1"><h3 class="m-0 [overflow-wrap:anywhere] text-[13px] font-medium leading-[1.4] text-zinc-100">${escapeHtml(system.name || system.repo)}</h3>${system.description ? `<span class="repository-description mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-zinc-400">${escapeHtml(system.description)}</span>` : ""}</div>${selectedTeam === "all" ? `<span class="team-tag max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-zinc-500">${escapeHtml(system.team)}</span>` : ""}<span class="row-arrow shrink-0 text-base text-zinc-500">${arrow}</span></a>`,
      )
      .join("");
  }
  filterRepositories();
}
async function loadWorkspace() {
  const authenticated = await loadUser();
  authenticatedUser = authenticated;
  const dashboardLayout = document.querySelector("#dashboard-layout");
  if (!authenticated) {
    const authError = new URLSearchParams(location.search).get("auth_error") === "1";
    const isProjectLink = Boolean(
      new URLSearchParams(location.search).get("team") && new URLSearchParams(location.search).get("repo"),
    );
    showGuestWelcome(
      authError
        ? "We couldn’t complete sign-in. Please try again."
        : isProjectLink
          ? "Sign in to open this project. After signing in, return to your project link."
          : "",
      isProjectLink ? "Your project link will still be here when you’re ready." : "",
    );
    return;
  }
  await uiComponentsLoad;
  dashboardLayout.hidden = false;
  dashboardLayout.setAttribute("aria-busy", "false");
  document.querySelector("#guest-welcome").hidden = true;
  document.querySelector("#creation-controls").hidden = false;
  document.querySelectorAll("[data-create]").forEach((button) => {
    button.hidden = false;
  });
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
      teamList.innerHTML = '<span class="section-note text-sm text-zinc-500">Teams are unavailable.</span>';
      systemGrid.innerHTML =
        '<div class="empty rounded border border-dashed border-zinc-700 bg-zinc-900/50 p-5 text-left text-xs text-zinc-400">Could not load design systems. Please try again.</div>';
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
    systemsLoaded = true;
    const currentSystem = systems.find((item) => item.org === new URLSearchParams(location.search).get("system"));
    if (currentSystem) {
      selectedTeam = currentSystem.team;
    }
    renderTeams();
    renderSystems();
  } catch {
    setNotice("Could not connect to the design-system service.");
    teamList.innerHTML = '<span class="section-note text-sm text-zinc-500">Teams are unavailable.</span>';
    systemGrid.innerHTML =
      '<div class="empty rounded border border-dashed border-zinc-700 bg-zinc-900/50 p-5 text-left text-xs text-zinc-400">Could not load design systems. Please try again.</div>';
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
  systemsLoaded = true;
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
    history.replaceState(null, "", `/?teamSlug=${encodeURIComponent(selectedTeam)}`);
    systemGrid.classList.remove("system-overview");
    document.querySelector('.dashboard-heading [data-create="system"]').hidden = false;
    renderTeams();
    renderSystems();
    teamForm.reset();
    document.querySelector("#creation-dialog").close();
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
    location.href = systemUrl(data.designSystem.team);
  } catch (error) {
    setNotice(error.message || "Could not create design system.");
  } finally {
    button.disabled = false;
  }
});
const firstSystemForm = document.querySelector("#first-system-form");
firstSystemForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = firstSystemForm.querySelector("input[name=name]");
  const status = document.querySelector("#first-system-status");
  const button = firstSystemForm.querySelector("button[type=submit]");
  const name = input.value.trim();
  const teamSlug = selectedTeam === "all" ? (typeof teams[0] === "string" ? teams[0] : teams[0]?.slug) : selectedTeam;
  const teamExists = teams.some((team) => (typeof team === "string" ? team : team.slug) === teamSlug);
  const nameSlug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  status.textContent = "";
  if (!nameSlug) {
    status.textContent = "Enter a name with at least one letter or number.";
    input.focus();
    return;
  }
  if (!teamExists) {
    status.textContent = "Create a team before creating a design system.";
    return;
  }
  const slug = `${nameSlug}-${teamSlug}`.slice(0, 100).replace(/[-.]+$/g, "");
  button.disabled = true;
  button.textContent = "Creating…";
  status.textContent = "Creating your design system…";
  try {
    const response = await fetch("/api/design-systems", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: teamSlug, slug, gitOrg: slug, name, type: "design-system" }),
    });
    const data = await responseData(response);
    if (!response.ok) {
      throw new Error(data.error || `Could not create design system (HTTP ${response.status}).`);
    }
    location.href = systemUrl(data.designSystem?.team || slug);
  } catch (error) {
    status.textContent = error.message || "Could not create your design system.";
  } finally {
    button.disabled = false;
    button.textContent = "Create";
  }
});
const params = new URLSearchParams(location.search);
const team = params.get("team");
const repo = params.get("repo");
if (team && repo) {
  landing.hidden = true;
  workspace.classList.remove("hidden");
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
    showGuestWelcome(
      "Sign in to open this project. After signing in, return to your project link.",
      "Your project link will still be here when you’re ready.",
    );
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
  let baseRef = source.baseRef;
  status.textContent = `${project.type === "component" ? "Team component" : "Design system"} · ${source.revision} · ${source.sourceMode}`;
  if (project.type === "design-system") {
    const components = projects.filter((item) => item.team === team && item.type === "component");
    area.innerHTML = `<div class="studio-heading flex w-full max-w-none items-center justify-between gap-5 border-b border-zinc-800 bg-zinc-900 px-5 py-3 max-[600px]:items-start max-[600px]:flex-col"><div class="min-w-0"><p class="studio-kicker hidden">${escapeHtml(team)} / ${escapeHtml(repo)} · Foundation</p><h1 class="text-[15px] font-medium tracking-normal text-zinc-100">${escapeHtml(project.name || repo)}</h1><p class="hidden">Shared tokens and a CSS reset for every page that uses this styleguide.</p></div><div class="studio-actions flex-wrap"><span class="state-pill whitespace-nowrap px-2.5 py-1.5 text-xs text-zinc-400" id="foundation-state">Ready</span><button type="button" id="save-tokens" disabled>Save Foundation</button><button class="secondary-action" type="button" id="publish-tokens">Publish</button></div></div><div class="foundation-layout grid min-h-[calc(100dvh-110px)] w-full max-w-none grid-cols-[256px_minmax(0,1fr)] overflow-hidden bg-zinc-950 max-[760px]:grid-cols-1"><nav class="studio-nav flex min-w-0 flex-col gap-3 bg-zinc-900 px-3 py-4 max-[760px]:border-b max-[760px]:border-zinc-800" aria-label="Foundation navigation"><details class="project-drawer border-t border-slate-700 pt-3" open><summary class="cursor-pointer text-xs font-bold text-slate-300">Foundation navigation</summary><div class="project-nav-content flex flex-col gap-3 border-t border-slate-700 pt-3"><strong class="text-xs font-bold uppercase tracking-wide text-slate-400">System</strong><a class="nav-context rounded-md bg-indigo-950 p-2 text-indigo-200" href="/?team=${encodeURIComponent(team)}&amp;repo=${encodeURIComponent(repo)}">${escapeHtml(project.name || repo)}</a><strong class="text-xs font-bold uppercase tracking-wide text-slate-400">Foundation files</strong><a class="rounded-md px-2 py-1 text-sm text-slate-300 hover:bg-slate-800" href="#foundation-tokens">tokens.css</a><a class="rounded-md px-2 py-1 text-sm text-slate-300 hover:bg-slate-800" href="#foundation-reset">reset.css</a><strong class="text-xs font-bold uppercase tracking-wide text-slate-400">Components</strong><div class="component-list flex flex-col gap-2">${components.map((item) => `<a class="rounded-lg border border-slate-700 p-2 text-sm font-medium text-slate-200 hover:border-indigo-400 hover:bg-slate-800" href="/?team=${encodeURIComponent(team)}&amp;repo=${encodeURIComponent(item.repo)}">${escapeHtml(item.name || item.repo)}<small class="mt-1 block truncate text-xs text-slate-400">${escapeHtml(item.repo)}</small></a>`).join("") || '<p class="text-sm text-slate-400">No components yet.</p>'}</div></div></details></nav><section class="foundation-main mx-auto w-full max-w-[1400px] min-w-0 px-8 py-6 max-[760px]:px-4 max-[760px]:py-5"><div class="foundation-title mb-4"><div><p class="eyebrow text-[10px] font-semibold tracking-[.12em] text-zinc-500">FOUNDATION REPOSITORY</p><h2 class="font-mono text-base font-normal text-zinc-100" id="foundation-tokens">tokens.css</h2><p class="mt-1 text-xs text-zinc-400">Shared source for every component in this system.</p></div></div><div id="foundation-urls" class="foundation-urls my-4 grid min-w-0 grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" aria-label="Published Foundation stylesheet URLs"></div><code-editor class="my-4 block h-[430px] min-h-[430px] w-full overflow-hidden rounded border border-zinc-800" id="tokens-editor" role="group" aria-label="Foundation CSS"></code-editor><div class="action-row mt-3 flex items-end gap-2"><label class="grid max-w-xs gap-1 text-xs text-slate-300"><span class="visually-hidden">Describe your changes</span><input class="w-full rounded-md border border-slate-600 bg-slate-800 p-2 text-sm text-slate-100" aria-label="Describe your changes" id="tokens-message" placeholder="Describe your changes" maxlength="200"></label></div><p class="text-xs text-zinc-400" id="token-status" role="status" aria-live="polite"></p><section class="foundation-components mt-7 border-t border-slate-700 pt-5"><div><h2 class="text-sm font-medium text-zinc-100">Component projects</h2><p class="mt-1 text-xs text-zinc-400">New components use this system’s published tokens at latest.</p></div><p class="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-400" id="token-publication-state" role="status" aria-live="polite">Checking published tokens…</p><form class="mt-4 grid gap-3 rounded border border-zinc-800 bg-zinc-900 p-3" id="component-create" hidden><label class="grid min-w-0 gap-1 text-xs text-zinc-400">Component name<input class="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-[13px] text-zinc-300" name="name" required maxlength="100" autocomplete="off"></label><p class="text-xs text-zinc-400">Available after tokens.css is published.</p><button class="min-h-[30px] justify-self-start rounded bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900" type="submit">Add component</button></form><p class="text-xs text-zinc-400" id="create-status" role="status" aria-live="polite"></p></section></section></div>`;

    await loadCodeEditor();
    const tokensEditor = area.querySelector("#tokens-editor");
    const tokenStatus = area.querySelector("#token-status");
    document.querySelector("#work-status").classList.add("hidden");
    document.querySelector("#work-area").classList.remove("p-6");
    document.querySelector("#work-area").classList.add("p-0");
    const foundationActions = area.querySelector(".studio-actions");
    foundationActions.classList.add("flex", "items-center", "justify-end", "gap-2", "max-[600px]:flex-wrap");
    area
      .querySelector("#save-tokens")
      .classList.add(
        "min-h-[30px]",
        "rounded",
        "bg-zinc-100",
        "px-3",
        "py-1.5",
        "text-xs",
        "font-medium",
        "text-zinc-900",
        "hover:bg-white",
        "disabled:cursor-not-allowed",
        "disabled:opacity-30",
      );
    area.querySelector("#foundation-state").classList.add("border-0", "bg-transparent");
    area
      .querySelector("#publish-tokens")
      .classList.add(
        "min-h-[30px]",
        "rounded",
        "bg-zinc-700",
        "px-3",
        "py-1.5",
        "text-xs",
        "font-medium",
        "text-white",
        "hover:bg-zinc-600",
      );
    tokensEditor.value = source.files["tokens.css"] || "";
    tokensEditor.language = "css";
    tokensEditor.status = "tokens.css";
    const foundationDraft = enhanceFoundation(area, source, () => {
      area.querySelector("#foundation-state").textContent = "Unsaved changes";
    });
    workbenchNavigation(area, project, projects, team, repo);
    area.querySelector(".project-drawer").open = !window.matchMedia("(max-width: 760px)").matches;
    const componentForm = area.querySelector("#component-create");
    const artifactUrl = `/static/${encodeURIComponent(team)}/${encodeURIComponent(repo)}/latest/tokens.css`;
    const resetUrl = `/static/${encodeURIComponent(team)}/${encodeURIComponent(repo)}/latest/reset.css`;
    const urls = area.querySelector("#foundation-urls");
    urls.classList.add("p-4");
    urls.innerHTML = `<label class="grid min-w-0 gap-1 text-sm text-zinc-400">Public tokens.css URL<input class="h-9 w-full min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-300" readonly value="${escapeHtml(new URL(artifactUrl, location.origin).href)}"></label><button class="min-h-[30px] rounded bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white" type="button" aria-label="Copy tokens.css URL" data-copy-url="tokens.css">Copy</button><label class="grid min-w-0 gap-1 text-sm text-zinc-400">Public reset.css URL<input class="h-9 w-full min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-300" readonly value="${escapeHtml(new URL(resetUrl, location.origin).href)}"></label><button class="min-h-[30px] rounded bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white" type="button" aria-label="Copy reset.css URL" data-copy-url="reset.css">Copy</button><span role="status" aria-live="polite"></span>`;
    urls.querySelectorAll("button[data-copy-url]").forEach((button) =>
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(urls.querySelector(`input[value*="/${button.dataset.copyUrl}"]`).value);
          urls.querySelector('[role="status"]').textContent = `${button.dataset.copyUrl} URL copied.`;
        } catch {
          urls.querySelector('[role="status"]').textContent = "Copy unavailable; select and copy the URL above.";
        }
      }),
    );
    const saveButton = area.querySelector("#save-tokens");
    const publishButton = area.querySelector("#publish-tokens");
    const updateFoundationState = () => {
      saveButton.disabled = !foundationDraft.isDirty();
      publishButton.disabled = !saveButton.disabled;
      area.querySelector("#foundation-state").textContent = saveButton.disabled ? "Ready" : "Unsaved changes";
    };
    const probePublishedTokens = async () => {
      componentForm.hidden = true;
      area.querySelector("#foundation-new-component").disabled = true;
      const publicationState = area.querySelector("#token-publication-state");
      try {
        const response = await fetch(artifactUrl, { method: "HEAD", cache: "no-store" });
        componentForm.hidden = !response.ok;
        area.querySelector("#foundation-new-component").disabled = !response.ok;
        publicationState.textContent = response.ok
          ? "Published tokens.css is available; component creation is unlocked."
          : "tokens.css is not published yet; publish it to unlock component creation.";
      } catch {
        componentForm.hidden = true;
        publicationState.textContent = "Could not verify token publication; component creation remains locked.";
      }
    };
    probePublishedTokens();
    saveButton.addEventListener("click", async () => {
      const files = { ...foundationDraft() };
      const deleteFiles = [...foundationDraft.deleteFiles];
      const response = await fetch(`/api/source/${encodeURIComponent(team)}/${encodeURIComponent(repo)}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          files,
          deleteFiles,
          baseRef,
          message: area.querySelector("#tokens-message").value.trim() || "Update Foundation",
        }),
      });
      const data = await responseData(response);
      tokenStatus.textContent = response.ok ? "" : data.error || "Could not save Foundation.";
      if (response.ok) {
        baseRef = data.baseRef || baseRef;
        foundationDraft.markSaved(files);
        updateFoundationState();
      }
    });
    area.querySelector("#publish-tokens").addEventListener("click", async () => {
      const response = await fetch(`/api/publish/${encodeURIComponent(team)}/${encodeURIComponent(repo)}`, {
        method: "POST",
        credentials: "same-origin",
      });
      const data = await responseData(response);
      tokenStatus.textContent = response.ok ? "" : data.error || "Could not publish tokens.";
      if (response.ok) {
        area.querySelector("#foundation-state").textContent = "Published";
        await probePublishedTokens();
      }
    });
    updateFoundationState();
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
    ...source.files,
    "component.html":
      source.files["component.html"] ||
      '<template component="ds-component" shadow-dom="open"><div data-wds-editable class="p-4 bg-indigo-600 text-white">Hello component</div></template>',
    "styles.css": source.files["styles.css"] || "",
  };
  if (source.files["component.mjs"] !== undefined) {
    files["component.mjs"] = source.files["component.mjs"];
  }
  area.innerHTML = `<div class="studio-heading mx-auto mb-5 flex max-w-screen-2xl flex-wrap items-center justify-between gap-5"><div class="min-w-0"><p class="studio-kicker text-sm font-bold text-indigo-700"><a href="/?team=${encodeURIComponent(team)}&amp;repo=${encodeURIComponent(project.designSystem?.repo || "foundation")}">${escapeHtml(project.designSystem?.repo || "Workspace")}</a> / ${escapeHtml(repo)} · Component</p><h1 class="text-3xl font-semibold tracking-tight text-slate-900">${escapeHtml(project.name || repo)}</h1><p class="mt-1 text-sm text-slate-500">Component authoring · canonical source</p></div><div class="studio-actions flex flex-wrap items-center justify-end gap-2"><span class="state-pill whitespace-nowrap rounded-full border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600" id="draft-state">Draft · ${escapeHtml(source.revision)}</span><button class="min-h-10 rounded-md bg-indigo-600 px-4 font-semibold text-white hover:bg-indigo-700" type="button" id="history-toggle" aria-expanded="false">History</button><button class="min-h-10 rounded-md bg-indigo-600 px-4 font-semibold text-white hover:bg-indigo-700" type="button" id="save-source">Commit</button><button class="secondary-action min-h-10 rounded-md bg-slate-700 px-4 font-semibold text-white" type="button" id="publish-source">Publish</button></div></div><div class="studio-shell mx-auto grid min-h-[650px] max-w-screen-2xl grid-cols-1 overflow-hidden rounded-xl border border-slate-200 bg-white lg:grid-cols-[205px_minmax(0,1fr)_235px]"><nav class="studio-nav flex min-w-0 flex-col gap-3 border-b border-slate-200 bg-slate-50 p-4 md:border-r md:border-b-0" aria-label="Project navigation"><details class="project-drawer border-t border-slate-200 pt-3" open><summary class="cursor-pointer text-xs font-bold text-slate-600">Project & files</summary><div class="project-nav-content flex flex-col gap-3 border-t border-slate-200 pt-3"><strong class="text-xs font-bold uppercase tracking-wide text-slate-500">System</strong><a class="nav-context rounded-md bg-indigo-50 p-2 text-indigo-800" href="/?team=${encodeURIComponent(team)}&amp;repo=${encodeURIComponent(project.designSystem?.repo || "foundation")}">${escapeHtml(project.designSystem?.repo || "Design system")}</a><strong>Current component</strong><span class="current-component break-words text-sm text-slate-600">${escapeHtml(project.name || repo)}</span><strong>Files</strong><label class="file-label text-xs text-slate-600" for="source-file">Select source file</label><select class="min-h-24 w-full rounded-md border border-slate-300 bg-white p-1" id="source-file" size="${Object.keys(files).length}">${Object.keys(
    files,
  )
    .concat(files["component.mjs"] === undefined ? ["component.mjs"] : [])
    .map(
      (file) =>
        `<option value="${escapeHtml(file)}" ${file === "component.mjs" && files["component.mjs"] === undefined ? "disabled" : ""}>${escapeHtml(file)}</option>`,
    )
    .join(
      "",
    )}</select><label class="module-toggle flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" id="enable-module" ${files["component.mjs"] !== undefined ? "checked" : ""}> Include component.mjs</label><details class="history-drawer mt-2 border-t border-slate-200 pt-3"><summary class="cursor-pointer text-xs font-bold text-indigo-800">History & status</summary><label class="grid gap-1 text-xs text-slate-600">Commit message<input class="w-full rounded-md border border-slate-300 bg-white p-2" id="commit-message" value="Update component source" maxlength="200"></label><p class="text-xs text-slate-600" id="save-status" role="status" aria-live="polite"></p><button class="min-h-10 rounded-md bg-indigo-600 px-4 font-semibold text-white" type="button" id="refresh-history">Refresh history</button><ol class="max-h-48 list-decimal space-y-2 overflow-auto pl-5 text-xs text-slate-600" id="history-list"></ol><p class="text-xs text-slate-600" id="publish-result" role="status" aria-live="polite"></p></details></div></details></nav><main class="authoring-main order-1 min-w-0 p-4 lg:order-none"><div class="mode-bar flex flex-wrap items-center justify-between gap-3"><div class="flex gap-0.5 rounded-lg border border-slate-200 p-1" role="tablist" aria-label="Authoring mode"><button type="button" class="mode-button active rounded-md px-3.5 py-2 aria-selected:bg-indigo-50 aria-selected:text-indigo-800" data-mode="design" role="tab" aria-selected="true">Design</button><button type="button" class="mode-button rounded-md px-3.5 py-2 aria-selected:bg-indigo-50 aria-selected:text-indigo-800" data-mode="code" role="tab" aria-selected="false">Code</button></div><label class="viewport-control flex items-center gap-2 text-xs text-slate-500">Canvas width <input class="w-[min(180px,24vw)]" type="range" id="canvas-width" min="320" max="1200" value="760"><output id="canvas-width-label">760 px</output></label></div><section class="design-surface min-w-0" data-surface="design"><div class="surface-heading my-4 flex items-baseline justify-between gap-3"><h2>Design canvas</h2><span class="preview-limit text-xs text-slate-500">Draft preview · sandboxed · scripts are not executed</span></div><iframe class="mx-auto block min-h-[340px] w-full transition-[width] duration-150 md:min-h-[470px]" title="Draft component preview" sandbox="" id="draft-preview"></iframe></section><section class="code-surface min-w-0" data-surface="code" hidden><div class="surface-heading my-4 flex items-baseline justify-between gap-3"><h2>Code · <span id="active-file-label">component.html</span></h2><span>Edits update the canonical draft source.</span></div><code-editor class="block h-[370px] min-h-[370px] w-full md:h-[500px] md:min-h-[500px]" id="source-editor" role="group" aria-label="Component source"></code-editor></section></main><aside class="studio-inspector order-2 border-t border-slate-200 bg-slate-50 p-4 lg:order-none lg:border-t-0 lg:border-l"><details class="inspector-drawer" open><summary class="cursor-pointer text-xs font-bold text-slate-600">Inspector · selected target</summary><div class="inspector-fields flex flex-col gap-3 border-t border-slate-200 pt-3"><p class="text-xs text-slate-600">Template root · <code class="rounded bg-slate-200 px-1 py-0.5 font-mono">data-wds-editable</code></p><p class="break-all rounded bg-white p-2 font-mono text-xs text-slate-600" id="selected-classes"></p><label class="grid gap-1 text-xs text-slate-600">Padding<select class="w-full rounded-md border border-slate-300 bg-white p-2" data-utility="padding"><option value="">none</option><option>p-2</option><option>p-4</option><option>p-6</option><option>p-8</option></select></label><label class="grid gap-1 text-xs text-slate-600">Margin<select class="w-full rounded-md border border-slate-300 bg-white p-2" data-utility="margin"><option value="">none</option><option>m-2</option><option>m-4</option><option>mt-4</option><option>mb-4</option><option>mx-auto</option></select></label><label class="grid gap-1 text-xs text-slate-600">Background<select class="w-full rounded-md border border-slate-300 bg-white p-2" data-utility="background"><option value="">none</option><option>bg-indigo-600</option><option>bg-blue-600</option><option>bg-slate-900</option><option>bg-white</option></select></label><label class="grid gap-1 text-xs text-slate-600">Text color<select class="w-full rounded-md border border-slate-300 bg-white p-2" data-utility="text"><option value="">none</option><option>text-white</option><option>text-slate-900</option><option>text-indigo-700</option></select></label><label class="grid gap-1 text-xs text-slate-600">Custom Tailwind utility<input class="w-full rounded-md border border-slate-300 bg-white p-2" id="custom-utility" placeholder="rounded-lg" maxlength="80"></label><button class="min-h-10 rounded-md bg-indigo-600 px-4 font-semibold text-white" type="button" id="apply-utility">Apply utility</button></div></details></aside></div>`;
  area.querySelector("#commit-message")?.remove();
  area.querySelector("#history-toggle")?.remove();
  area.querySelector("#preview-toggle")?.remove();
  const setResponsiveDrawers = () => {
    const mobile = window.matchMedia("(max-width: 760px)").matches;
    area.querySelector(".project-drawer").open = !mobile;
    area.querySelector(".inspector-drawer").open = !mobile;
  };
  setResponsiveDrawers();
  window.matchMedia("(max-width: 760px)").addEventListener("change", setResponsiveDrawers);
  const editor = area.querySelector("#source-editor");
  const fileSelect = area.querySelector("#source-file");
  fileSelect.value = Object.hasOwn(files, "component.html") ? "component.html" : Object.keys(files)[0] || "";
  let activeFile = fileSelect.value;
  const languageForFile = (file) =>
    ({
      ".css": "css",
      ".html": "html",
      ".js": "javascript",
      ".json": "json",
      ".mjs": "javascript",
      ".svg": "xml",
    })[file.slice(file.lastIndexOf(".")).toLowerCase()] || "";
  const updateEditor = ({ saveCurrent = false } = {}) => {
    if (saveCurrent) {
      files[activeFile] = editor.value;
    }
    activeFile = fileSelect.value;
    editor.value = files[fileSelect.value];
    editor.language = languageForFile(activeFile);
    editor.status = activeFile;
    area.querySelector("#active-file-label").textContent = fileSelect.value;
  };
  const modeButtons = [...area.querySelectorAll("[data-mode]")];
  modeButtons.forEach((button) => {
    button.classList.remove("text-slate-600");
    button.classList.add(
      "min-h-9",
      "text-xs",
      "font-medium",
      "text-zinc-400",
      "hover:bg-zinc-800",
      "hover:text-zinc-100",
    );
  });
  const publishButton = area.querySelector("#publish-source");
  publishButton.innerHTML =
    '<span class="publish-indicator inline-block size-2 rounded-full bg-transparent ring-1 ring-zinc-500" aria-hidden="true"></span> Publish';
  publishButton.disabled = true;
  const updatePublishState = (dirty) => {
    publishButton.disabled = !dirty;
    const indicator = publishButton.querySelector(".publish-indicator");
    indicator.classList.toggle("bg-amber-400", dirty);
    indicator.classList.toggle("ring-amber-300", dirty);
    indicator.classList.toggle("bg-transparent", !dirty);
    indicator.classList.toggle("ring-zinc-500", !dirty);
  };
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
        item.setAttribute("aria-selected", String(item === button));
      });
      area.querySelectorAll("[data-surface]").forEach((surface) => {
        surface.style.display = surface.dataset.surface === button.dataset.mode ? "" : "none";
      });
      const codeMode = button.dataset.mode === "code";
      area.querySelector(".studio-nav").classList.toggle("hidden", codeMode);
      area.querySelector(".studio-inspector").classList.toggle("hidden", codeMode);
      area.querySelector(".studio-shell").style.gridTemplateColumns = codeMode ? "minmax(0, 1fr)" : "";
    }),
  );
  area.querySelector("#canvas-width").addEventListener("input", (event) => {
    const width = Number(event.target.value);
    area.querySelector("#draft-preview").style.width = `min(100%, ${width}px)`;
    area.querySelector("#canvas-width-label").value = `${width} px`;
  });
  let refreshPreview;
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
    updatePublishState(true);
  });
  editor.addEventListener("change", (event) => {
    files[activeFile] = typeof event.detail === "string" ? event.detail : editor.value;
    refreshPreview();
    updatePublishState(true);
  });
  area.querySelector("#save-source").addEventListener("click", async () => {
    files[fileSelect.value] = editor.value;
    const response = await fetch(`/api/source/${encodeURIComponent(team)}/${encodeURIComponent(repo)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files,
        baseRef,
        message: "Update component source",
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
      baseRef = data.baseRef || baseRef;
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
      updatePublishState(false);
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
  const studio = createStudio(area, files, () => {
    if (activeFile === "component.html") {
      editor.value = files[activeFile];
    }
    area.querySelector("#draft-state").textContent = "Unsaved changes";
    updatePublishState(true);
  });
  await loadCodeEditor();
  refreshPreview = studio.refresh;
  workbenchNavigation(area, project, projects, team, repo);
  updateEditor();
  refreshPreview();
  loadHistory();
}
