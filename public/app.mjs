import { createStudio } from "./studio.mjs";
import { registerEditorFallback } from "./editor-fallback.mjs";
import { initializeUiComponents } from "./ui-components.mjs";
import {
  initializeNavigation,
  filterRepositories,
  dashboardHeading,
  renderSystemOverview,
  workbenchNavigation,
  enhanceFoundation,
} from "./navigation.mjs";
function initializeApp() {
  initializeNavigation();
  const uiComponentsLoad = Promise.race([
    initializeUiComponents(),
    new Promise((resolve) => window.setTimeout(() => resolve(false), 2000)),
  ]);

  const landing = document.querySelector("#landing");
  const workspace = document.querySelector("#workspace");
  const teamList = document.querySelector("#team-list");
  const systemGrid = document.querySelector("#system-grid");
  document.querySelector(".dashboard-main").append(workspace);
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
  let systems = [];
  let teams = [];
  let projects = [];
  let systemsLoaded = false;
  let selectedTeam = new URLSearchParams(location.search).get("teamSlug") || "all";
  let authenticatedUser = false;
  let currentUser = null;
  let activeWorkbench = "";
  let editorDirty = false;
  let foundationDirty = false;
  let themeChoice = "system";
  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
    );
  }
  function isAgentUser(user) {
    return (
      user.role === "agent" ||
      user.type === "agent" ||
      user.principal_type === "agent" ||
      user.kind === "agent" ||
      user.agent === true
    );
  }
  function setUserCard(target, user, authenticated) {
    if (!authenticated) {
      target.hidden = true;
      return;
    }
    target.hidden = false;
    const isAgent = isAgentUser(user);
    const label = user.name || user.preferred_username || user.email || "Signed in";
    const initials =
      label
        .split(/[\s@._-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase() || "W";
    const avatar = isAgent ? "Ag" : initials;
    target.innerHTML = `<span class="user-avatar inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-emerald-950 text-sm font-semibold text-white">${!isAgent && user.photo ? `<img class="h-full w-full object-cover" src="${escapeHtml(user.photo)}" alt="">` : escapeHtml(avatar)}</span><span class="user-copy flex min-w-0 flex-col"><span class="user-name truncate text-sm font-semibold text-zinc-100">${escapeHtml(label)}</span><span class="user-label truncate text-xs text-zinc-400">${isAgent ? "Agent" : escapeHtml(user.email || "WDS account")}</span></span>`;
  }
  async function loadUser() {
    let data = {};
    try {
      const response = await fetch("/api/oidc/me", {
        credentials: "same-origin",
      });
      if (response.ok) {
        data = await response.json();
      }
    } catch {
      // The account card remains in its signed-out state if session lookup fails.
    }
    for (const card of document.querySelectorAll(".user-card")) {
      setUserCard(card, data.user || {}, data.authenticated === true);
      card.onclick = () => {
        const params = new URLSearchParams(location.search);
        params.set("view", "preferences");
        navigateTo(`/?${params.toString()}`);
      };
    }
    currentUser = data.user || null;
    return data.authenticated === true;
  }
  const authPropertiesUrl = "https://auth.api.apphor.de/api/v1/properties";
  const validThemes = new Set(["dark", "light", "system"]);
  let themeMediaQuery;
  function applyTheme(choice) {
    themeChoice = validThemes.has(choice) ? choice : "system";
    if (!themeMediaQuery) {
      themeMediaQuery = window.matchMedia("(prefers-color-scheme: light)");
      themeMediaQuery.addEventListener("change", () => {
        if (themeChoice === "system") {
          document.documentElement.dataset.theme = themeMediaQuery.matches ? "light" : "dark";
        }
      });
    }
    const resolved = themeChoice === "system" ? (themeMediaQuery.matches ? "light" : "dark") : themeChoice;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }
  async function loadThemePreference() {
    applyTheme("system");
    try {
      const response = await fetch(authPropertiesUrl, { credentials: "include" });
      if (!response.ok) {
        return;
      }
      const properties = await response.json();
      const saved = Array.isArray(properties) ? properties.find((property) => property.key === "wds.theme") : null;
      if (validThemes.has(saved?.value)) {
        applyTheme(saved.value);
      }
    } catch {
      // The app remains usable with the system theme if Auth properties are unavailable.
    }
  }
  async function saveThemePreference(value) {
    const status = document.querySelector("#theme-status");
    if (!validThemes.has(value)) {
      return;
    }
    applyTheme(value);
    status.textContent = "Saving…";
    try {
      const response = await fetch(authPropertiesUrl, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "wds.theme", value }),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401 ? "Sign in to Auth again to save preferences." : "Could not save this preference.",
        );
      }
      status.textContent = "Theme saved.";
    } catch (error) {
      status.textContent = error.message || "Auth preferences are unavailable right now.";
    }
  }
  function renderPreferences() {
    const profile = document.querySelector("#preferences-profile");
    if (currentUser) {
      const isAgent = isAgentUser(currentUser);
      const label = currentUser.name || currentUser.preferred_username || currentUser.email || "Signed in";
      const avatar = isAgent
        ? "Ag"
        : label
            .split(/[\s@._-]+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0])
            .join("")
            .toUpperCase();
      profile.innerHTML = `<span class="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full bg-violet-800 text-2xl font-semibold text-white">${!isAgent && currentUser.photo ? `<img class="h-full w-full object-cover" src="${escapeHtml(currentUser.photo)}" alt="">` : escapeHtml(avatar)}</span><span class="min-w-0"><span class="block truncate text-xl font-bold">${escapeHtml(label)}</span><span class="block truncate text-base text-slate-500">${isAgent ? "Agent" : escapeHtml(currentUser.email || "")}</span></span>`;
    }
    document.querySelector("#theme-preference").value = themeChoice;
  }
  function initializeEditorNavigation() {
    const toggle = document.querySelector(".editor-nav-toggle");
    const area = document.querySelector("#landing");
    if (!toggle || !area) {
      return;
    }
    const close = () => {
      document.querySelector("#project-content")?.classList.remove("mobile-nav-open");
      toggle.setAttribute("aria-expanded", "false");
    };
    toggle.addEventListener("click", () => {
      const content = document.querySelector("#project-content");
      const opened = content?.classList.toggle("mobile-nav-open") || false;
      toggle.setAttribute("aria-expanded", String(opened));
    });
    document.addEventListener("click", (event) => {
      if (event.target.closest(".mobile-nav-overlay") || event.target.closest(".studio-nav a")) {
        close();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        close();
      }
    });
  }
  initializeEditorNavigation();
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
    document.querySelector("#app-topbar").hidden = true;
  }
  function createDataCard({ href, title, subtitle, count, meta, iconText = "▱", kind = "system" }) {
    const card = document.createElement("a");
    card.href = href;
    card.className = `${kind}-card group flex min-h-40 flex-col rounded-2xl border border-zinc-800 bg-zinc-900 p-5 text-left transition hover:-translate-y-0.5 hover:border-blue-400 hover:bg-zinc-800`;
    card.dataset.search = `${title} ${subtitle}`.toLowerCase();
    const icon = document.createElement("span");
    icon.className =
      "mb-5 grid size-10 place-items-center rounded-xl border border-blue-500/20 bg-blue-500/10 text-xl text-blue-300";
    icon.textContent = iconText;
    const heading = document.createElement("h2");
    heading.className = "m-0 text-base font-semibold text-zinc-100";
    heading.textContent = title;
    const description = document.createElement("p");
    description.className = "mt-1 text-xs text-zinc-400";
    description.textContent = subtitle;
    const footer = document.createElement("div");
    footer.className = "mt-auto flex w-full items-end justify-between gap-2 pt-5 text-xs";
    const metric = document.createElement("span");
    metric.className = "font-medium text-zinc-300";
    metric.textContent = count;
    const detail = document.createElement("span");
    detail.className = "text-zinc-500";
    detail.textContent = meta;
    footer.append(metric, detail);
    card.append(icon, heading, description, footer);
    return card;
  }
  function renderTeamCards() {
    const title = document.querySelector("#dashboard-title");
    title.textContent = "Your teams";
    title.hidden = false;
    document.querySelector("#dashboard-breadcrumbs").hidden = true;
    document.querySelector("#teams-title").textContent = "Teams";
    document.querySelector("#systems-title").textContent = "Teams";
    document.querySelector("#system-filter").hidden = true;
    document.querySelector(".list-toolbar").classList.add("hidden");
    document.querySelector("#system-summary").textContent = `${teams.length} ${teams.length === 1 ? "team" : "teams"}`;
    systemGrid.className = "system-grid grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3";
    systemGrid.render(
      teams,
      (team) => {
        const slug = typeof team === "string" ? team : team.slug;
        const count = systems.filter((system) => system.team === slug).length;
        return createDataCard({
          href: `/?teamSlug=${encodeURIComponent(slug)}`,
          title: typeof team === "string" ? team : team.name || slug,
          subtitle: `Team · ${slug}`,
          count: "Members not tracked",
          meta: `${count} ${count === 1 ? "design system" : "design systems"}`,
          iconText: "T",
          kind: "team",
        });
      },
      "No teams yet. Create your first team to get started.",
    );
  }
  function renderTeams() {
    const createButton = document.querySelector(".sidebar-create");
    const systemRoute = new URLSearchParams(location.search).has("system");
    createButton.dataset.create = selectedTeam === "all" ? "team" : "system";
    createButton.textContent = selectedTeam === "all" ? "＋ New team" : "＋ New system";
    createButton.hidden = systemRoute;
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
    const selector = document.querySelector("#system-team");
    if (selector) {
      selector.replaceChildren(...availableTeams.map((item) => new Option(item, item)));
      if (selectedTeam !== "all" && availableTeams.includes(selectedTeam)) {
        selector.value = selectedTeam;
      }
    }
    const systemsHeading = document.querySelector("#teams-title");
    if (selectedTeam !== "all") {
      const selectedSystems = systems.filter((system) => system.team === selectedTeam);
      systemsHeading.textContent = "Design systems";
      document.querySelector("#team-summary").textContent = `${selectedSystems.length}`;
      teamList.render(
        selectedSystems,
        (system) => {
          const link = document.createElement("a");
          link.className = "block rounded px-2 py-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-blue-400";
          link.href = `/?teamSlug=${encodeURIComponent(selectedTeam)}&system=${encodeURIComponent(system.org || system.team)}`;
          link.textContent = system.name || system.repo;
          return link;
        },
        "No design systems yet.",
      );
      return;
    }
    systemsHeading.textContent = "Teams";
    teamList.render(
      teams,
      (team) => {
        const slug = typeof team === "string" ? team : team.slug;
        const link = document.createElement("a");
        link.className = "block rounded px-2 py-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-blue-400";
        link.href = `/?teamSlug=${encodeURIComponent(slug)}`;
        link.textContent = typeof team === "string" ? team : team.name || slug;
        return link;
      },
      "Teams will appear here when you have access to a design system.",
    );
  }
  function renderSystems() {
    const dashboardContent = document.querySelector("#dashboard-content");
    const toolbar = document.querySelector(".list-toolbar");
    if (toolbar && toolbar.parentElement !== systemGrid.parentElement) {
      systemGrid.parentElement.insertBefore(toolbar, systemGrid);
    }
    const systemFilter = document.querySelector("#system-filter");
    if (systemFilter) {
      systemFilter.value = "";
    }
    document.querySelector("#filter-empty").hidden = true;
    const emptyState = document.querySelector("#first-system-empty");
    const dashboardLayout = document.querySelector("#dashboard-layout");
    emptyState.hidden = true;
    dashboardContent.hidden = false;
    dashboardLayout.hidden = false;
    if (systemsLoaded && teams.length === 0 && systems.length === 0) {
      dashboardLayout.setAttribute("data-empty", "");
      dashboardContent.hidden = true;
      document.querySelector("#first-team-empty").hidden = false;
      return;
    }
    document.querySelector("#first-team-empty").hidden = true;
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
    if (selectedTeam === "all") {
      renderTeamCards();
      return;
    }
    dashboardHeading(selectedTeam);
    document.querySelector("#dashboard-title").textContent = "Design systems";
    document.querySelector("#dashboard-title").hidden = false;
    document.querySelector("#systems-title").textContent = "Design systems";
    document.querySelector("#system-filter").hidden = false;
    document.querySelector(".list-toolbar").classList.remove("hidden");
    const visible = systems.filter((system) => system.team === selectedTeam);
    document.querySelector("#system-summary").textContent = "";
    if (!visible.length) {
      const availableTeams = teams.map((team) => (typeof team === "string" ? team : team.slug));
      if (systemsLoaded && availableTeams.length > 0) {
        dashboardContent.hidden = true;
        emptyState.hidden = false;
        return;
      }
      systemGrid.render([], () => document.createElement("div"), "No design systems yet.");
      return;
    }
    systemGrid.className = "system-grid grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3";
    systemGrid.render(
      visible,
      (system) =>
        createDataCard({
          href: `/?teamSlug=${encodeURIComponent(selectedTeam)}&system=${encodeURIComponent(system.org || system.team)}`,
          title: system.name || system.repo,
          subtitle: system.description || "Design system",
          count: `${system.componentCount || 0} components`,
          meta: "Open →",
          iconText: "◇",
        }),
      "No design systems yet.",
    );
    filterRepositories();
  }
  function updateFirstTeamState() {
    const noTeams = teams.length === 0 && systems.length === 0;
    const layout = document.querySelector("#dashboard-layout");
    layout.toggleAttribute("data-empty", noTeams);
    document.querySelector("#dashboard-content").hidden = noTeams;
    document.querySelector("#first-team-empty").hidden = !noTeams;
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
    await loadThemePreference();
    document.querySelector("#app-topbar").hidden = false;
    dashboardLayout.hidden = false;
    dashboardLayout.setAttribute("aria-busy", "false");
    document.querySelector("#guest-welcome").hidden = true;
    document.querySelector("#creation-controls").hidden = false;
    document.querySelectorAll("[data-create]").forEach((button) => {
      button.hidden = false;
    });
    try {
      const [teamsResponse, systemsResponse, projectsResponse] = await Promise.all([
        fetch("/api/teams", { credentials: "same-origin" }),
        fetch("/api/design-systems", { credentials: "same-origin" }),
        fetch("/api/projects", { credentials: "same-origin" }),
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
      const projectData = projectsResponse.ok ? await responseData(projectsResponse) : [];
      projects = Array.isArray(projectData) ? projectData : [];
      teams = Array.isArray(teamData.teams) ? teamData.teams : [];
      systems = (registered.designSystems || []).map((system) => ({
        team: teams.find((item) => String(item.id) === String(system.team_id))?.slug || system.team || system.git_org,
        org: system.git_org,
        repo: system.foundation_repo,
        name: system.name,
        type: "design-system",
        componentCount: projects.filter((project) => project.team === system.git_org && project.type === "component")
          .length,
      }));
      systemsLoaded = true;
      updateFirstTeamState();
      const currentSystem = systems.find((item) => item.org === new URLSearchParams(location.search).get("system"));
      if (currentSystem) {
        selectedTeam = currentSystem.team;
      }
      await renderCurrentRoute();
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
    const [teamsResponse, systemsResponse, projectsResponse] = await Promise.all([
      fetch("/api/teams", { credentials: "same-origin" }),
      fetch("/api/design-systems", { credentials: "same-origin" }),
      fetch("/api/projects", { credentials: "same-origin" }),
    ]);
    const teamData = await responseData(teamsResponse);
    const registered = await responseData(systemsResponse);
    const projectData = projectsResponse.ok ? await responseData(projectsResponse) : [];
    projects = Array.isArray(projectData) ? projectData : [];
    if (!teamsResponse.ok || !systemsResponse.ok) {
      throw new Error(teamData.error || registered.error || "Could not refresh teams and design systems.");
    }
    teams = Array.isArray(teamData.teams) ? teamData.teams : [];
    systems = (registered.designSystems || []).map((system) => ({
      team: teams.find((item) => String(item.id) === String(system.team_id))?.slug || system.team || system.git_org,
      org: system.git_org,
      repo: system.foundation_repo,
      name: system.name,
      type: "design-system",
      componentCount: projects.filter((project) => project.team === system.git_org && project.type === "component")
        .length,
    }));
    systemsLoaded = true;
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
      updateFirstTeamState();
      navigateTo(`/?teamSlug=${encodeURIComponent(selectedTeam)}`);
      await renderCurrentRoute();
      systemGrid.classList.remove("system-overview");
      document.querySelector('.dashboard-heading [data-create="system"]').hidden = false;
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
      systemForm.reset();
      setNotice("Design system created.");
      navigateTo(`/?teamSlug=${encodeURIComponent(selectedTeam)}&system=${encodeURIComponent(data.designSystem.team)}`);
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
        body: JSON.stringify({
          team: teamSlug,
          slug,
          gitOrg: slug,
          name,
          type: "design-system",
        }),
      });
      const data = await responseData(response);
      if (!response.ok) {
        throw new Error(data.error || `Could not create design system (HTTP ${response.status}).`);
      }
      await refreshWorkspace();
      navigateTo(
        `/?teamSlug=${encodeURIComponent(teamSlug)}&system=${encodeURIComponent(data.designSystem?.team || slug)}`,
      );
    } catch (error) {
      status.textContent = error.message || "Could not create your design system.";
    } finally {
      button.disabled = false;
      button.textContent = "Create";
    }
  });
  let lastAcceptedUrl = `${location.pathname}${location.search}${location.hash}`;
  function navigateTo(value, { replace = false } = {}) {
    const target = value instanceof URL ? value : new URL(value, location.origin);
    const currentParams = new URLSearchParams(location.search);
    const nextParams = target.searchParams;
    const currentProject = `${currentParams.get("team") || ""}/${currentParams.get("repo") || ""}`;
    const nextProject = `${nextParams.get("team") || ""}/${nextParams.get("repo") || ""}`;
    if (
      (editorDirty || foundationDirty) &&
      currentProject !== "/" &&
      currentProject !== nextProject &&
      !window.confirm("You have unsaved component changes. Leave this editor?")
    ) {
      return false;
    }
    const nextUrl = `${target.pathname}${target.search}${target.hash}`;
    if (replace) {
      history.replaceState(null, "", nextUrl);
    } else {
      history.pushState(null, "", nextUrl);
    }
    lastAcceptedUrl = nextUrl;
    void renderCurrentRoute();
    return true;
  }
  async function renderCurrentRoute() {
    if (!authenticatedUser) {
      return;
    }
    const params = new URLSearchParams(location.search);
    const preferences = params.get("view") === "preferences";
    const team = params.get("team");
    const repo = params.get("repo");
    const system = params.get("system");
    const dashboardContent = document.querySelector("#dashboard-content");
    const firstTeam = document.querySelector("#first-team-empty");
    const firstSystem = document.querySelector("#first-system-empty");
    const preferencesView = document.querySelector("#preferences-view");
    const topbarName = document.querySelector("#workspace-name");
    workspace.classList.add("hidden");
    preferencesView.classList.add("hidden");
    dashboardContent.hidden = false;
    firstTeam.hidden = true;
    firstSystem.hidden = true;
    landing.hidden = false;
    document.querySelector("#dashboard-layout").hidden = false;
    if (preferences) {
      dashboardContent.hidden = true;
      firstTeam.hidden = true;
      firstSystem.hidden = true;
      preferencesView.classList.remove("hidden");
      renderPreferences();
      topbarName.textContent = "Preferences";
      document.title = "Preferences · Workbench";
      return;
    }
    if (team && repo) {
      dashboardContent.hidden = true;
      firstTeam.hidden = true;
      firstSystem.hidden = true;
      workspace.classList.remove("hidden");
      const key = `${team}/${repo}`;
      if (activeWorkbench !== key) {
        activeWorkbench = key;
        editorDirty = false;
        foundationDirty = false;
        topbarName.textContent = `${team} / ${repo}`;
        document.title = `${repo} · Workbench`;
        await loadWorkbench(team, repo);
      }
      return;
    }
    activeWorkbench = activeWorkbench || "";
    selectedTeam = params.get("teamSlug") || "all";
    if (system) {
      selectedTeam = systems.find((item) => item.org === system)?.team || selectedTeam;
    }
    renderTeams();
    renderSystems();
    const selectedSystems = systems.filter((item) => item.team === selectedTeam);
    if (selectedTeam === "all" && !system && teams.length === 0) {
      firstTeam.hidden = false;
      dashboardContent.hidden = true;
    } else if (selectedTeam !== "all" && !system && selectedSystems.length === 0) {
      firstSystem.hidden = false;
      dashboardContent.hidden = true;
    }
    topbarName.textContent = system
      ? systems.find((item) => item.org === system)?.name || system
      : selectedTeam === "all"
        ? "Your teams"
        : selectedTeam;
    document.title = system
      ? `${topbarName.textContent} · Workbench`
      : selectedTeam === "all"
        ? "Your teams · Workbench"
        : `${selectedTeam} · Workbench`;
  }
  document.addEventListener("click", (event) => {
    const anchor = event.target.closest("a[href]");
    if (
      !anchor ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      anchor.target === "_blank"
    ) {
      return;
    }
    const target = new URL(anchor.href, location.href);
    if (target.origin !== location.origin || target.pathname !== "/") {
      return;
    }
    if (target.search === location.search && target.hash) {
      return;
    }
    event.preventDefault();
    navigateTo(target);
  });
  window.addEventListener("wds:navigate", (event) => navigateTo(event.detail));
  window.addEventListener("popstate", () => {
    const params = new URLSearchParams(location.search);
    const team = params.get("team");
    const repo = params.get("repo");
    const nextProject = team && repo ? `${team}/${repo}` : "";
    if ((editorDirty || foundationDirty) && activeWorkbench && nextProject !== activeWorkbench) {
      if (!window.confirm("You have unsaved component changes. Leave this editor?")) {
        history.pushState(null, "", lastAcceptedUrl);
        return;
      }
    }
    lastAcceptedUrl = `${location.pathname}${location.search}${location.hash}`;
    void renderCurrentRoute();
  });
  window.addEventListener("beforeunload", (event) => {
    if (editorDirty || foundationDirty) {
      event.preventDefault();
    }
  });
  document
    .querySelector("#theme-preference")
    .addEventListener("change", (event) => saveThemePreference(event.target.value));
  document.querySelector("#preferences-sign-out").addEventListener("click", async () => {
    const button = document.querySelector("#preferences-sign-out");
    const status = document.querySelector("#theme-status");
    button.disabled = true;
    status.textContent = "Signing out…";
    try {
      const response = await fetch("/api/oidc/logout", { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error("Sign out failed. Please try again.");
      }
      authenticatedUser = false;
      editorDirty = false;
      foundationDirty = false;
      activeWorkbench = "";
      navigateTo("/", { replace: true });
      showGuestWelcome("", "");
    } catch {
      status.textContent = "Could not sign out. Check your connection and try again.";
    } finally {
      button.disabled = false;
    }
  });
  loadWorkspace();

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
    const projectResponse = await fetch("/api/projects", {
      credentials: "same-origin",
    });
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
    document.querySelector("#workspace-name").replaceChildren();
    const context = document.createElement("span");
    context.textContent = project.designSystem?.name || team;
    const separator = document.createElement("span");
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = "/";
    const projectName = document.createElement("span");
    projectName.textContent = project.type === "component" ? project.name || repo : "Foundation";
    document.querySelector("#workspace-name").append(context, separator, projectName);
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
        foundationDirty = true;
        area.querySelector("#foundation-state").textContent = "Unsaved changes";
      });
      workbenchNavigation(area, project, projects, team, repo);
      const foundationDrawer = area.querySelector(".project-drawer");
      if (foundationDrawer) {
        foundationDrawer.open = !window.matchMedia("(max-width: 760px)").matches;
      }
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
          const response = await fetch(artifactUrl, {
            method: "HEAD",
            cache: "no-store",
          });
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
          foundationDirty = false;
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
        navigateTo(`/?team=${encodeURIComponent(team)}&repo=${encodeURIComponent(slug)}`);
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
      const inspectorDrawer = area.querySelector(".inspector-drawer");
      if (inspectorDrawer) {
        inspectorDrawer.open = !mobile;
      }
    };
    setResponsiveDrawers();
    window.matchMedia("(max-width: 760px)").addEventListener("change", setResponsiveDrawers);
    const editor = area.querySelector("#source-editor");
    const editorNav = area.querySelector(".studio-nav");
    const moduleToggle = editorNav.querySelector("#enable-module")?.closest("label");
    const historyDrawer = editorNav.querySelector(".history-drawer");
    editorNav.replaceChildren();
    const codeSurface = area.querySelector(".code-surface");
    const fileTabs = document.createElement("div");
    fileTabs.id = "source-tabs";
    fileTabs.className = "source-tabs flex min-w-0 gap-1 overflow-x-auto border-b border-zinc-800";
    fileTabs.setAttribute("role", "tablist");
    fileTabs.setAttribute("aria-label", "Component files");
    codeSurface.querySelector(".surface-heading").after(fileTabs);
    if (moduleToggle) {
      moduleToggle.className = "module-toggle my-2 flex items-center gap-2 text-xs text-zinc-400";
      codeSurface.prepend(moduleToggle);
    }
    if (historyDrawer) {
      codeSurface.append(historyDrawer);
    }
    let activeFile = Object.hasOwn(files, "component.html") ? "component.html" : Object.keys(files)[0] || "";
    const languageForFile = (file) =>
      ({
        ".css": "css",
        ".html": "html",
        ".js": "javascript",
        ".json": "json",
        ".mjs": "javascript",
        ".svg": "xml",
      })[file.slice(file.lastIndexOf(".")).toLowerCase()] || "";
    const renderFileTabs = () => {
      fileTabs.replaceChildren();
      for (const file of Object.keys(files)) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.role = "tab";
        tab.id = `source-tab-${file.replace(/[^a-z0-9_-]/gi, "-")}`;
        tab.dataset.file = file;
        tab.setAttribute("aria-selected", String(file === activeFile));
        tab.className =
          "source-file-tab rounded-t-md border-b-2 border-transparent px-3 py-2 text-xs text-zinc-400 hover:text-zinc-100 aria-selected:border-blue-400 aria-selected:text-zinc-100";
        tab.textContent = file;
        tab.addEventListener("click", () => selectFile(file));
        fileTabs.append(tab);
      }
    };
    const updateEditor = ({ saveCurrent = false } = {}) => {
      if (saveCurrent) {
        files[activeFile] = editor.value;
      }
      editor.value = files[activeFile] ?? "";
      editor.language = languageForFile(activeFile);
      editor.status = activeFile;
      area.querySelector("#active-file-label").textContent = activeFile;
      renderFileTabs();
    };
    const selectFile = (file) => {
      if (!Object.hasOwn(files, file)) {
        return;
      }
      updateEditor({ saveCurrent: true });
      activeFile = file;
      updateEditor();
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
    const saveButton = area.querySelector("#save-source");
    area.querySelector("#draft-state").remove();
    const codeTab = area.querySelector('[data-mode="code"]');
    const markCodeDirty = () => {
      editorDirty = true;
      if (!codeTab.textContent.endsWith(" *")) {
        codeTab.textContent = `${codeTab.textContent} *`;
      }
    };
    area.querySelector(".studio-actions").prepend(saveButton, publishButton);
    const saveFeedback = document.createElement("p");
    saveFeedback.id = "save-feedback";
    saveFeedback.className = "save-feedback max-w-64 text-xs text-zinc-400";
    saveFeedback.setAttribute("role", "status");
    saveFeedback.setAttribute("aria-live", "polite");
    saveFeedback.style.display = "none";
    area.querySelector(".studio-actions").append(saveFeedback);
    publishButton.innerHTML =
      '<span class="publish-indicator inline-block size-2 rounded-full bg-transparent ring-1 ring-zinc-500" aria-hidden="true"></span> Publish';
    publishButton.disabled = true;
    const updatePublishState = (available) => {
      publishButton.disabled = !available;
      const indicator = publishButton.querySelector(".publish-indicator");
      indicator.classList.toggle("bg-amber-400", available);
      indicator.classList.toggle("ring-amber-300", available);
      indicator.classList.toggle("bg-transparent", !available);
      indicator.classList.toggle("ring-zinc-500", !available);
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
          surface.hidden = surface.dataset.surface !== button.dataset.mode;
        });
        const codeMode = button.dataset.mode === "code";
        area.querySelector(".studio-nav").classList.remove("hidden");
        area.querySelector(".studio-inspector").classList.toggle("hidden", codeMode);
        area.querySelector(".studio-shell").style.gridTemplateColumns = codeMode
          ? "minmax(190px, 230px) minmax(0, 1fr)"
          : "minmax(190px, 230px) minmax(0, 1fr) minmax(280px, 320px)";
      }),
    );
    area.querySelector("#canvas-width").addEventListener("input", (event) => {
      const width = Number(event.target.value);
      area.querySelector("#draft-preview").style.width = `min(100%, ${width}px)`;
      area.querySelector("#canvas-width-label").value = `${width} px`;
    });
    let refreshPreview;
    area.querySelector("#enable-module").addEventListener("change", (event) => {
      if (event.target.checked) {
        files["component.mjs"] = "export const componentName = 'component';\n";
        if (!/component\.mjs/.test(files["component.html"])) {
          files["component.html"] += '\n<script type="module" src="./component.mjs"></script>\n';
        }
      } else {
        delete files["component.mjs"];
        if (activeFile === "component.mjs") {
          activeFile = "component.html";
        }
      }
      updateEditor();
      refreshPreview();
      markCodeDirty();
      updatePublishState(false);
    });
    editor.addEventListener("change", (event) => {
      files[activeFile] = typeof event.detail === "string" ? event.detail : (editor.value ?? "");
      markCodeDirty();
      refreshPreview();
      updatePublishState(false);
    });
    area.querySelector("#save-source").addEventListener("click", async () => {
      files[activeFile] = editor.value;
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
      const saveStatus = area.querySelector("#save-status");
      const message = response.ok
        ? `Committed ${data.revision} (${data.sourceMode}).`
        : `${data.error || `Save failed (${response.status}).`}${data.file ? ` File: ${data.file}` : ""}`;
      saveStatus.classList.toggle("text-rose-400", !response.ok);
      saveStatus.classList.toggle("text-zinc-400", response.ok);
      saveStatus.textContent = message;
      saveFeedback.classList.toggle("text-rose-400", !response.ok);
      saveFeedback.classList.toggle("text-zinc-400", response.ok);
      saveFeedback.textContent = message;
      saveFeedback.style.setProperty("display", "inline-block", "important");
      if (response.ok) {
        baseRef = data.baseRef || baseRef;
        editorDirty = false;
        codeTab.textContent = codeTab.textContent.replace(/ \*$/, "");
        updatePublishState(true);
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
        editorDirty = false;
        codeTab.textContent = codeTab.textContent.replace(/ \*$/, "");
        updatePublishState(false);
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
      markCodeDirty();
      updatePublishState(false);
    });
    await loadCodeEditor();
    refreshPreview = studio.refresh;
    updateEditor();
    refreshPreview();
    loadHistory();
  }
}

function initializeAfterAppTemplate() {
  const appTemplate = document.querySelector("template[app]");
  if (!appTemplate) {
    initializeApp();
    return;
  }
  appTemplate.replaceWith(appTemplate.content.cloneNode(true));
  initializeApp();
}

initializeAfterAppTemplate();
