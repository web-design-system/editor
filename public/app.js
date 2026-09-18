const files = ['component.html', 'styles.css', 'buttons.mjs', 'stories.html', 'component.json', 'spec.mjs'];
const state = { team: 'acme-corp', repo: 'buttons', active: 'component.html', files: {}, revision: '' };
const $ = (selector) => document.querySelector(selector);
const editor = $('#editor');

function url(path) { return `/static/${state.team}/${state.repo}/latest/${path}`; }
function renderTabs() {
  $('#tabs').replaceChildren(...files.map((file) => {
    const button = document.createElement('button');
    button.textContent = file;
    button.className = file === state.active ? 'active' : '';
    button.onclick = () => { state.files[state.active] = editor.value; state.active = file; editor.value = state.files[file] || ''; renderTabs(); };
    return button;
  }));
}
function refreshPreview() {
  $('#frame').src = `${url('stories.html')}?t=${Date.now()}`;
  $('#component-url').href = url('component.html');
  $('#component-url').textContent = 'component.html / latest';
  $('#styleguide-url').href = url('stories.html');
  $('#styleguide-url').textContent = 'styleguide.html / latest';
}
function metadata() {
  try {
    const data = JSON.parse(state.files['component.json']);
    $('#description').textContent = data.description || 'No description.';
    $('#metadata').innerHTML = `<div><dt>Element</dt><dd>${data.name || 'unset'}</dd></div><div><dt>Branch</dt><dd>main</dd></div><div><dt>Serving</dt><dd>public latest</dd></div>`;
  } catch { $('#description').textContent = 'Invalid component.json'; }
}
async function loadProject(team, repo) {
  const response = await fetch(`/api/source/${team}/${repo}`);
  if (!response.ok) return;
  const payload = await response.json();
  Object.assign(state, { team, repo, files: payload.files, revision: payload.revision, active: 'component.html' });
  editor.value = state.files[state.active];
  $('#crumb-team').textContent = team; $('#crumb-repo').textContent = repo; $('#revision').textContent = payload.revision;
  renderTabs(); metadata(); refreshPreview();
}
async function loadProjects() {
  const projects = await (await fetch('/api/projects')).json();
  const list = $('#project-list'); list.replaceChildren(...projects.map((project) => {
    const button = document.createElement('button');
    button.className = `project ${project.team === state.team && project.repo === state.repo ? 'selected' : ''}`;
    button.innerHTML = `<span>${project.team}</span><strong>${project.repo}</strong><code>${project.revision}</code>`;
    button.onclick = () => loadProject(project.team, project.repo).then(loadProjects);
    return button;
  }));
}
async function commit() {
  state.files[state.active] = editor.value;
  $('#save-status').textContent = 'Committing source...';
  const response = await fetch(`/api/source/${state.team}/${state.repo}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: state.files, message: `Update ${state.active}` }) });
  const result = await response.json();
  state.revision = result.revision; $('#revision').textContent = result.revision;
  $('#save-status').textContent = `Committed ${result.revision}; latest updated`;
  metadata(); refreshPreview(); loadProjects();
}
function setupViewport() {
  const range = $('#viewport'); const frame = $('#frame');
  const points = [['sm', 640], ['md', 768], ['lg', 1024]];
  const update = () => { frame.style.width = `${range.value}px`; $('#width-readout').textContent = `${range.value} px`; };
  range.oninput = update; update();
  $('#breakpoints').replaceChildren(...points.map(([name, width]) => { const button = document.createElement('button'); button.textContent = `${name} ${width}`; button.onclick = () => { range.value = width; update(); }; return button; }));
}
$('#commit').onclick = commit;
editor.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); } });
$('#release').onclick = () => $('#release-dialog').showModal();
$('#release-dialog').addEventListener('close', async () => {
  const kind = $('#release-dialog').returnValue;
  if (!['major', 'minor'].includes(kind)) return;
  const response = await fetch(`/api/release/${state.team}/${state.repo}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) });
  const release = await response.json(); $('#save-status').textContent = `Released ${release.version} from ${release.revision}`;
});
$('#new-project').onclick = () => $('#project-dialog').showModal();
$('#project-dialog').addEventListener('close', async () => {
  if ($('#project-dialog').returnValue !== 'create') return;
  const form = $('#project-dialog form'); const values = Object.fromEntries(new FormData(form));
  const response = await fetch(`/api/source/${values.team}/${values.repo}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: state.files, message: 'Initial component source' }) });
  if (response.ok) { await loadProject(values.team, values.repo); loadProjects(); form.reset(); }
});
setupViewport();
await loadProject(state.team, state.repo);
await loadProjects();
