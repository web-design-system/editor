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
  const availableTeams = [...new Set([...teams, ...systems.map((system) => system.team)])].sort((a, b) =>
    a.localeCompare(b),
  );
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
    systemGrid.innerHTML = `<div class="empty">${systems.length ? "There are no design systems in this team yet." : "No design systems are available for your account yet."}</div>`;
    return;
  }
  systemGrid.innerHTML = visible
    .map(
      (system) =>
        `<a class="system-card" href="/?team=${encodeURIComponent(system.team)}&amp;repo=${encodeURIComponent(system.repo)}" aria-label="Open ${escapeHtml(system.name || system.repo)}"><div class="card-top"><span class="system-icon">${icon}</span><span class="team-tag">${escapeHtml(system.team)}</span></div><h3>${escapeHtml(system.name || system.repo)}</h3><p>${escapeHtml(system.description || "Shared design tokens and component styles.")}</p><span class="card-footer"><span>${escapeHtml(system.repo)}</span><span class="open-label">Open ${arrow}</span></span></a>`,
    )
    .join("");
}
async function loadWorkspace() {
  const authenticated = await loadUser();
  if (!authenticated) {
    landing.hidden = false;
    setNotice("Sign in to browse design systems in this workspace.", true);
    teamList.innerHTML = '<span class="section-note">Sign in to load teams.</span>';
    systemGrid.innerHTML = '<div class="empty">Your design systems will appear here after sign-in.</div>';
    return;
  }
  try {
    const [response, teamsResponse] = await Promise.all([
      fetch("/api/projects", { credentials: "same-origin" }),
      fetch("/api/teams", { credentials: "same-origin" }),
    ]);
    if (response.status === 401) {
      setNotice("Your session has expired.", true);
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setNotice(data.error || `Could not load teams (HTTP ${response.status}).`);
      teamList.innerHTML = '<span class="section-note">Teams are unavailable.</span>';
      systemGrid.innerHTML = '<div class="empty">Could not load design systems. Please try again.</div>';
      return;
    }
    const projects = await response.json();
    systems = Array.isArray(projects) ? projects.filter((project) => project.type === "design-system") : [];
    if (teamsResponse.ok) {
      const teamData = await teamsResponse.json();
      teams = Array.isArray(teamData.teams) ? teamData.teams : [];
    }
    renderTeams();
    renderSystems();
  } catch {
    setNotice("Could not connect to the design-system service.");
    teamList.innerHTML = '<span class="section-note">Teams are unavailable.</span>';
    systemGrid.innerHTML = '<div class="empty">Could not load design systems. Please try again.</div>';
  }
}
const params = new URLSearchParams(location.search);
const team = params.get("team");
const repo = params.get("repo");
if (team && repo) {
  landing.hidden = true;
  workspace.style.display = "block";
  document.querySelector("#workspace-name").textContent = `${team} / ${repo}`;
  document.title = `${repo} · Workbench`;
  loadUser();
} else {
  loadWorkspace();
}
