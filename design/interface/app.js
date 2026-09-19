// Interface simulation only. No microphone, model, filesystem or host calls.
const $ = (id) => document.getElementById(id);
const objects = [...document.querySelectorAll('[data-artifact]')];
const names = ['page', 'note', 'tool'];
const titles = { page: 'Fieldnotes', note: 'On noticing', tool: 'A little sorter' };
const captions = [
  '“A small place to keep what you notice. Let me make that.”',
  '“Here’s the page. I’ll keep your first thought beside it.”',
  '“These notes could use a little sorter. I can make one here.”',
  '“The page and your note are ready. The sorter still needs a decision.”',
];
function sample(machine = false) {
  return { count: 3, seen: 3, work: 'ready', connected: true, mic: false, speaking: true,
    caption: captions[3], selected: 'page', admission: 'pending', merge: 'pending',
    undo: machine ? 'worktree' : 'written-file-list', extension: false, extensionResult: '', timer: null,
    events: ['Example conversation: “Make a little place for things I notice on a walk.”',
      'Fieldnotes page created (sample).', 'On noticing note created (sample).',
      'Little sorter written. Admission pending (sample).'] };
}
const projects = { browser: sample(), machine: sample(true) };
let project = 'browser';
let view = 'studio';
const current = () => projects[project];
const projectId = () => project === 'browser' ? 'fieldnotes@this-browser' : 'fieldnotes@box';
const undoWords = {
  'written-file-list': ['recorded file changes', 'Restore recorded previous bytes and remove files that were previously absent. Filenames alone are not enough.'],
  worktree: ['separate worktree', 'Changes are isolated in this execution root. Discarding it does not undo work already merged, published or sent elsewhere.'],
  'git-branch': ['branch recovery', 'Return to the recorded base on this branch. Untracked files, external effects and published changes are outside that recovery.'],
  none: ['no automatic undo', 'Unprompted writes are withheld. Only inherently reversible work may proceed without a decision.'],
};
function event(text, state = current()) { state.events.push(text); if (state === current()) renderLog(); }
function announce(text) { $('announcement').textContent = text; }
function open(id) { const d = $(id); if (!d.open) d.showModal(); }
function closeAll() { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); }
function showRequest() { closeAll(); renderRequest(); open('review-dialog'); }
function renderLog() {
  $('event-log').replaceChildren(...current().events.map((text, index) => {
    const li = document.createElement('li');
    const label = document.createElement('small');
    label.textContent = `${projectId()} · local study event ${index + 1}`;
    li.append(label, document.createTextNode(text));
    return li;
  }));
}
function renderRequest() {
  const s = current();
  $('request-origin').textContent = project === 'browser'
    ? 'Voice session · fieldnotes@this-browser · root notes · version 1'
    : 'Chat session · fieldnotes@box · root sorter · version 1';
  $('review-recovery').textContent = undoWords[s.undo][1];
  $('review-result').textContent = !s.connected ? 'Disconnected. Reconnect before answering.'
    : ({ pending: 'Pending · no tool has been enabled', allowed: 'Enabled in the study. No code ran.',
      denied: 'Not enabled. The file remains available to inspect.', elsewhere: 'Already answered by the chat instance. This request is no longer yours to answer.' })[s.admission];
  const closed = !s.connected || s.admission !== 'pending' || s.count < 3;
  $('allow').disabled = closed;
  $('deny').disabled = closed;
  $('answered-elsewhere').hidden = project !== 'machine';
  $('answered-elsewhere').disabled = closed;
}
function render() {
  const s = current();
  if (s.connected) s.seen = s.count;
  const count = s.connected ? s.count : s.seen;
  document.body.dataset.work = s.work;
  $('project-name').textContent = projectId();
  $('project-context').textContent = `${project === 'browser' ? 'Only in this browser · may be cleared' : 'On your machine · two live sessions'} · ${undoWords[s.undo][0]}`;
  $('people-count').textContent = project === 'browser' ? 'Just you' : '2 sessions';
  $('people-open').setAttribute('aria-label', project === 'browser' ? 'Here with you: only this browser' : 'Here with you: two sessions');
  $('browser-people').hidden = project !== 'browser';
  $('machine-people').hidden = project !== 'machine';
  $('chat-waiting').textContent = s.admission === 'pending' ? 'Waiting for a tool decision' : 'Tool decision recorded';
  $('presence-work').textContent = s.work === 'running' ? 'Making the next asset' : 'Page and note ready';
  $('people-review').disabled = !s.connected || count < 3;
  objects.forEach((el, i) => {
    el.hidden = i >= count;
    el.classList.toggle('selected', el.dataset.artifact === s.selected);
  });
  $('empty').hidden = count > 0;
  document.querySelector('.objects').hidden = count === 0;
  $('arrival-count').textContent = `${count} ${count === 1 ? 'thing' : 'things'}`;
  $('caption').textContent = s.connected ? s.caption : 'Connection lost. The mic is off. Reconnect to check the work.';
  $('voice-ring-wrap').dataset.voice = s.connected ? (s.speaking ? 'speaking' : s.mic ? 'listening' : 'off') : 'off';
  $('voice-state').textContent = !s.connected ? 'Disconnected · mic off' : s.speaking
    ? `Speaking in the study · mic ${s.mic ? 'on' : 'off'}` : s.mic ? 'Listening in the study' : 'Mic off · still here';
  $('mic').setAttribute('aria-pressed', String(s.mic && s.connected));
  $('mic').setAttribute('aria-label', !s.connected ? 'Reconnect the study' : s.mic ? 'Simulate muting microphone' : 'Simulate listening');
  $('interrupt').disabled = !s.speaking || !s.connected;
  $('pause').disabled = !s.connected || s.undo === 'none' || !['running', 'paused'].includes(s.work);
  $('pause').textContent = s.work === 'paused' ? 'Resume work' : 'Pause work';
  $('work-status').textContent = !s.connected ? 'Work state unconfirmed. Press the mic to reconnect.'
    : s.undo === 'none' ? 'No automatic undo · unprompted writes withheld.'
    : s.work === 'running' ? 'Making the next asset · you can interrupt me.'
    : s.work === 'paused' ? 'Work paused. Your assets are still here.' : 'Ready when you are.';
  $('play').disabled = !s.connected || s.undo === 'none';
  $('decision').hidden = count < 3 || s.admission !== 'pending';
  $('decision-title').textContent = project === 'browser' ? 'Use the little sorter here?' : 'Chat made a sorter. Enable it?';
  $('decision-description').textContent = project === 'browser' ? 'Reads notes. Writes collections. No network.' : 'For fieldnotes@box · root sorter';
  $('decision-review').disabled = !s.connected;
  $('tool-state').textContent = ({ pending: 'Made · not enabled', allowed: 'Enabled here · sample', denied: 'Made · not enabled', elsewhere: 'Answered in chat · sample' })[s.admission];
  $('return-summary').textContent = count < 3 ? `${count} assets are here. ${s.work === 'paused' ? 'The work is paused.' : 'There is more on the way.'}`
    : `A page and a note are ready. ${s.admission === 'pending' ? 'The sorter still needs a decision.' : 'The tool decision has been recorded.'}`;
  $('environment-title').textContent = project === 'browser' ? 'This browser' : 'A window onto your machine';
  $('environment-detail').textContent = project === 'browser'
    ? 'Example OPFS project. Files belong to this origin and browser profile. They do not live on the machine the chat agent can reach.'
    : 'Example machine project. The phone and chat sessions work in separate roots. Their work is not merged automatically.';
  $('storage-detail').textContent = project === 'browser'
    ? 'Example: not protected from automatic browser cleanup. Even protected storage is not a backup; clearing site data or deleting the profile can remove it.'
    : 'Example: files live on the machine, not in this browser. A lost connection does not establish that work stopped. Backups are a separate concern.';
  for (const option of $('undo-kind').options) option.disabled = project === 'browser' && ['worktree', 'git-branch'].includes(option.value);
  $('undo-kind').value = s.undo;
  $('undo-detail').textContent = undoWords[s.undo][1];
  $('capability-detail').textContent = project === 'browser'
    ? 'File and admitted Wasm tools. No shell tool in this environment. A shell-dependent tool needs a machine project; it is not a failed browser command.'
    : 'The example host can run its admitted tools. A newly written tool does not inherit shell or network authority just because it lives on a machine.';
  renderRequest();
  renderLog();
  renderExtensions();
}
function schedule(state, key) {
  clearTimeout(state.timer);
  if (state.work !== 'running') return;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (state.work !== 'running') return;
    state.count += 1;
    if (state.speaking) state.caption = captions[state.count];
    event(`${titles[names[state.count - 1]]} arrived (sample).`, state);
    if (state.count === 3) state.work = 'ready';
    if (project === key && state.connected) {
      render();
      objects[state.count - 1].classList.remove('arriving');
      objects[state.count - 1].classList.add('arriving');
      announce(`${titles[names[state.count - 1]]} added.`);
    }
    schedule(state, key);
  }, 1800);
}
function play() {
  const s = current();
  if (!s.connected || s.undo === 'none') return;
  clearTimeout(s.timer);
  Object.assign(s, { count: 0, seen: 0, work: 'running', speaking: true, admission: 'pending', merge: 'pending', selected: 'page', caption: captions[0] });
  event('Started the synthetic creation sequence.');
  $('merge-result').textContent = 'Proposed · not merged';
  $('keep-separate').disabled = false;
  $('merge-accept').disabled = false;
  render();
  schedule(s, project);
}
function chooseView(next) {
  view = next;
  document.body.dataset.view = next;
  document.querySelector('.return-intro').hidden = next !== 'return';
  document.querySelectorAll('nav [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === next)));
  render();
}
function decide(value) {
  const s = current();
  if (!s.connected || s.admission !== 'pending' || s.count < 3) return;
  s.admission = value;
  event(value === 'elsewhere' ? 'Chat instance answered the tool request first (sample).' : `Phone/browser instance answered tool request: ${value} (sample).`);
  render();
  announce($('review-result').textContent);
}
for (const [trigger, dialog] of [['project-open', 'project-dialog'], ['people-open', 'people-dialog'], ['logs-open', 'logs-dialog'], ['settings-open', 'settings-dialog'], ['type-open', 'type-dialog']]) {
  $(trigger).addEventListener('click', () => open(dialog));
}
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('nav [data-view]').forEach((b) => b.addEventListener('click', () => chooseView(b.dataset.view)));
$('continue-studio').addEventListener('click', () => chooseView('studio'));
$('play').addEventListener('click', play);
$('mic').addEventListener('click', () => {
  const s = current();
  if (!s.connected) {
    s.connected = true; s.mic = false; s.speaking = false;
    s.caption = '“We’re back. Your assets are here; the microphone is still off.”';
    event('Reconnected the study. Mic remains off; no turn was replayed.');
  } else {
    s.mic = !s.mic; s.speaking = false;
    s.caption = s.mic ? '“I’m here. What would you like to make next?”' : '“Mic off. The work stays where you left it.”';
    event(`Microphone ${s.mic ? 'on' : 'off'} in the study. No actual audio captured.`);
  }
  render();
});
$('interrupt').addEventListener('click', () => {
  const s = current(); s.speaking = false;
  s.caption = '“Of course. Go on.”';
  event('Stopped the example speech. Work was not cancelled.'); render();
});
$('pause').addEventListener('click', () => {
  const s = current();
  if (!s.connected || s.undo === 'none' || !['running', 'paused'].includes(s.work)) return;
  s.work = s.work === 'running' ? 'paused' : 'running';
  event(`Work ${s.work === 'paused' ? 'paused at its last asset' : 'resumed from its last asset'} (sample).`);
  schedule(s, project); render();
});
$('decision-review').addEventListener('click', showRequest);
$('people-review').addEventListener('click', showRequest);
$('artifact-review').addEventListener('click', showRequest);
$('allow').addEventListener('click', () => decide('allowed'));
$('deny').addEventListener('click', () => decide('denied'));
$('answered-elsewhere').addEventListener('click', () => decide('elsewhere'));
document.querySelectorAll('[data-project]').forEach((b) => b.addEventListener('click', () => {
  project = b.dataset.project; closeAll(); render(); announce(`Showing ${projectId()}. No files transferred.`);
}));
objects.forEach((el) => el.querySelector('button').addEventListener('click', () => {
  const kind = el.dataset.artifact;
  if (view === 'beside' && current().selected !== kind) { current().selected = kind; render(); return; }
  $('artifact-title').textContent = titles[kind];
  const content = el.querySelector('.artifact-open').firstElementChild.cloneNode(true);
  content.removeAttribute('aria-hidden');
  content.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  $('artifact-content').replaceChildren(content);
  $('artifact-provenance').textContent = `${projectId()} · ${kind === 'tool' && project === 'machine' ? 'chat session / sorter' : 'voice session / notes'} · revision 1 · synthetic asset`;
  $('artifact-review').hidden = kind !== 'tool';
  open('artifact-dialog');
}));
$('merge-open').addEventListener('click', () => {
  closeAll();
  const state = current().merge;
  $('merge-result').textContent = ({ pending: 'Proposed · not merged', accepted: 'Merged in the study. No files changed.', refused: 'Kept separate. Neither root was deleted.' })[state];
  $('keep-separate').disabled = state !== 'pending' || !current().connected;
  $('merge-accept').disabled = state !== 'pending' || !current().connected;
  open('merge-dialog');
});
for (const [id, value, message] of [['keep-separate', 'refused', 'Kept separate. Neither root was deleted.'], ['merge-accept', 'accepted', 'Merged in the study. No files changed.']]) {
  $(id).addEventListener('click', () => {
    if (project !== 'machine' || !current().connected || current().merge !== 'pending') return;
    current().merge = value; event(`${message} (sample)`);
    $('merge-result').textContent = message;
    $('keep-separate').disabled = true; $('merge-accept').disabled = true;
  });
}
document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => {
  if (r.value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = r.value;
}));
$('undo-kind').addEventListener('change', () => {
  const s = current(); s.undo = $('undo-kind').value;
  if (s.undo === 'none' && s.work === 'running') { s.work = 'paused'; clearTimeout(s.timer); }
  render();
});
$('disconnect').addEventListener('click', () => {
  const s = current(); s.connected = false; s.mic = false; s.speaking = false;
  if (project === 'browser' && s.work === 'running') { s.work = 'paused'; clearTimeout(s.timer); }
  event('Example connection lost. Mic stopped. Work state must be reconciled.');
  closeAll(); render();
});
$('text-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const words = $('utterance').value.trim();
  if (!words) return;
  event(`You typed: ${words}`);
  $('utterance').value = ''; closeAll();
  if (words.toLowerCase() === 'make something') play();
  else { current().caption = `“${words}” — kept in this tab’s log; no model is connected.`; current().speaking = false; render(); }
});
// The package preview is fixed illustrative source, never evaluated or imported.
const extensionSource = '(module\n  (import "notes" "read" (func $read))\n  (import "collections" "write" (func $write))\n  (func (export "group_notes")\n    call $read\n    call $write))';
function renderExtensions() {
  const s = current();
  const shell = $('package-example').value === 'shell';
  const extensionVersion = `${shell ? 'build-helper' : 'notebook-helper'} 1.0 · illustrative package`;
  $('extension-inventory').textContent = s.extension
    ? `Notebook helper 1.0 · local example package · publisher unverified · enabled for ${projectId()} only (simulation).`
    : 'No third-party extensions installed in this example. The little sorter was made in the conversation; it is a separate proposal.';
  $('package-origin').textContent = `${extensionVersion} · publisher unverified · destination ${projectId()}`;
  $('package-source').textContent = shell
    ? '// Illustrative machine-only package; NEVER executed by this study.\nexport async function build(shell) {\n  return shell.exec(["npm", "test"]);\n}'
    : extensionSource;
  $('package-read').textContent = shell ? 'Project files' : 'notes/*.md';
  $('package-write').textContent = shell ? 'Unbounded process effects' : 'collections/*.json';
  $('package-exec').textContent = shell ? 'Required: shell execution' : 'None requested';
  $('package-enforced').textContent = shell
    ? 'Not grantable here. Browser has no shell; this study has no contained machine runner either. Choosing a machine project does not turn this into an admitted tool.'
    : 'Proposed handles: notes (read), collections (write). Wasm imports only; no network or shell. These are example grants, not enforcement measured by this study.';
  $('package-warning').textContent = shell ? 'Cannot install this package in the example environment. Missing execution capability is an environment fact, not a command failure.'
    : s.extension ? 'This example version is already installed. A changed package would need a new review.'
    : 'Installation makes this exact example version available only here. A declaration is not a guarantee. A real host must verify the package and enforce these grants before admission.';
  $('install-example').disabled = shell || s.extension || !s.connected || s.undo === 'none';
  $('reject-example').disabled = !shell && s.extension;
  $('extension-result').textContent = s.extensionResult;
}
$('extensions-open').addEventListener('click', () => { closeAll(); renderExtensions(); open('extensions-dialog'); });
$('package-example').addEventListener('change', () => { current().extensionResult = ''; renderExtensions(); });
$('install-example').addEventListener('click', () => {
  if ($('package-example').value !== 'browser' || current().extension || !current().connected || current().undo === 'none') return;
  current().extension = true;
  current().extensionResult = 'Installed in the study only. No files changed; no code ran.';
  event('Explicitly installed notebook-helper 1.0 in the study. No package loaded or executed.');
  renderExtensions();
});
$('reject-example').addEventListener('click', () => {
  if ($('package-example').value === 'browser' && current().extension) return;
  current().extensionResult = 'Selected package not installed. Existing inventory unchanged.';
  event('Declined the example sideload; inventory unchanged.');
  renderExtensions();
});
// No automatic audio start, no persistence claim, no background provider work.
render();
