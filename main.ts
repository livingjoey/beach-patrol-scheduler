import { setRerender } from './app-state.ts';
import { IDENTIFIER, currentAdmin, refreshAdmin, restoreSession, runSetup, signIn, signOut } from './model.ts';
import { allLoaded, hosted, initStore, mode, onChange, state } from './store.ts';
import { $, html, icon, raw, toast, type Raw } from './util.ts';
import { scheduleView } from './views/schedule.ts';
import { personnelView } from './views/personnel.ts';
import { timeOffView } from './views/timeoff.ts';
import { assignmentsView } from './views/assignments.ts';
import { criteriaView } from './views/criteria.ts';
import { adminsView } from './views/admins.ts';
import { layoutsView } from './views/layouts.ts';
import { bindLogin, loginPage } from './views/login.ts';

export interface View {
  render(): Raw;
  bind(root: HTMLElement): void;
}

const ROUTES: { id: string; label: string; icon: string; view: View }[] = [
  { id: 'schedule', label: 'Schedule', icon: 'schedule', view: scheduleView },
  { id: 'personnel', label: 'Personnel', icon: 'personnel', view: personnelView },
  { id: 'timeoff', label: 'Time Off', icon: 'timeoff', view: timeOffView },
  { id: 'assignments', label: 'Assign', icon: 'assignments', view: assignmentsView },
  { id: 'layouts', label: 'Layouts', icon: 'layouts', view: layoutsView },
  { id: 'criteria', label: 'Criteria', icon: 'criteria', view: criteriaView },
  { id: 'admins', label: 'Admins', icon: 'admins', view: adminsView },
];

const route = () => ROUTES.find((r) => `#${r.id}` === location.hash) ?? ROUTES[0];

let dirty = false;
const app = () => $('#app')!;

function busyTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && app().contains(el) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

function rerender(force = false): void {
  if (!force && busyTyping()) {
    dirty = true;
    return;
  }
  dirty = false;
  const scrollers = [...app().querySelectorAll<HTMLElement>('[data-keep-scroll]')].map((el) => [el.dataset.keepScroll, el.scrollLeft, el.scrollTop] as const);
  const pageY = window.scrollY;
  draw();
  for (const [k, l, t] of scrollers) {
    const el = app().querySelector<HTMLElement>(`[data-keep-scroll="${k}"]`);
    if (el) {
      el.scrollLeft = l;
      el.scrollTop = t;
    }
  }
  window.scrollTo(0, pageY);
}

function draw(): void {
  if (!allLoaded()) {
    app().innerHTML = `<div class="center-screen"><div class="spinner" aria-hidden="true"></div><p>Loading the scheduler…</p></div>`;
    return;
  }
  if (mode === 'hosted') {
    const st = hosted.status!;
    if (st.setupNeeded) return drawSetup();
    if (!st.admin) return drawLogin();
    if (!hosted.synced) {
      app().innerHTML = `<div class="center-screen"><div class="spinner" aria-hidden="true"></div><p>Loading the scheduler…</p></div>`;
      return;
    }
    refreshAdmin();
    if (!currentAdmin) return drawLogin();
  } else {
    if (!state.certs || state.admins.size === 0) return drawSetup();
    refreshAdmin();
    if (!currentAdmin) return drawLogin();
  }
  const r = route();
  app().innerHTML = html`
    <div class="shell">
      <nav class="rail" aria-label="Main">
        <div class="brand">${icon('logo', 28, state.settings.patrolName)}</div>
        ${ROUTES.map((x) => html`<a class="navi${x === r ? ' on' : ''}" href="#${x.id}" ${x === r ? raw('aria-current="page"') : ''}>${icon(x.icon, 22)}<span>${x.label}</span></a>`)}
        <div class="rail-foot">
          <span class="me mono" title="${currentAdmin.displayName}">${currentAdmin.identifier}</span>
          <button type="button" class="navi" id="signout" aria-label="Sign out">${icon('out', 20)}<span>Sign out</span></button>
        </div>
      </nav>
      <main class="main" id="view">${r.view.render()}</main>
    </div>
    ${mode !== 'memory' ? '' : html`<div class="banner" role="status">Preview mode: changes are kept only until this page closes. Open the scheduler from its claude.ai link to save to the shared database.</div>`}
  `.value;
  $('#signout')!.addEventListener('click', async () => {
    await signOut();
    rerender(true);
  });
  r.view.bind($('#view')!);
}

function drawLogin(): void {
  app().innerHTML = loginPage().value;
  bindLogin(app(), async (id, pw) => {
    await signIn(id, pw);
    rerender(true);
  });
}

function drawSetup(): void {
  app().innerHTML = html`
    <div class="center-screen">
      <form class="card auth wide" id="setup" novalidate>
        <div class="auth-head">${icon('logo', 34)}<div><h1>Set up the Beach Patrol Scheduler</h1><p class="muted">This creates the certifications, Stands 1–11, Squads, Skis, Rescue Boats, Extras 1–10, six example criteria presets, and the first admin account.</p></div></div>
        <label class="field"><span>Patrol name</span><input id="su-name" class="input" value="Beach Patrol" maxlength="80"></label>
        <div class="row2">
          <label class="field"><span>First admin identifier</span><input id="su-id" class="input mono" value="ADM01" maxlength="20"></label>
          <label class="field"><span>Display name</span><input id="su-dn" class="input" value="Admin 01" maxlength="80"></label>
        </div>
        <label class="field"><span>Password (8+ characters)</span><input id="su-pw" class="input" type="password" autocomplete="new-password"></label>
        ${mode === 'hosted' && hosted.status?.setupCodeRequired ? html`<label class="field"><span>Setup code (SETUP_CODE in your hosting dashboard)</span><input id="su-code" class="input mono" autocomplete="off"></label>` : ''}
        <label class="check"><input type="checkbox" id="su-demo"> Add 76 placeholder lifeguards (LG10–LG85) to try things out</label>
        <p class="error" id="su-err" role="alert" hidden></p>
        <button class="btn primary" type="submit" id="su-go">Create scheduler</button>
      </form>
    </div>`.value;
  $('#setup')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id: string) => ($(`#${id}`) as HTMLInputElement).value.trim();
    const err = $('#su-err')!;
    const fail = (m: string) => {
      err.textContent = m;
      err.hidden = false;
    };
    if (!IDENTIFIER.test(v('su-id'))) return fail('The identifier can use 2–20 letters, digits, - or _.');
    if (($('#su-pw') as HTMLInputElement).value.length < 8) return fail('Choose a password with at least 8 characters.');
    const btn = $('#su-go') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Setting up…';
    try {
      await runSetup({ identifier: v('su-id'), displayName: v('su-dn') || v('su-id'), password: ($('#su-pw') as HTMLInputElement).value, patrolName: v('su-name'), demo: ($('#su-demo') as HTMLInputElement).checked, setupCode: ($('#su-code') as HTMLInputElement | null)?.value.trim() });
      toast('Scheduler created. You are signed in.');
      location.hash = '#schedule';
      rerender(true);
    } catch (x) {
      btn.disabled = false;
      btn.textContent = 'Create scheduler';
      fail((x as Error).message);
    }
  });
}

document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (dirty && !busyTyping()) rerender();
  }, 0);
});
window.addEventListener('hashchange', () => rerender(true));
onChange(() => {
  if (state.admins.size && !currentAdmin) restoreSession();
  rerender();
});

setRerender(rerender);
draw();
initStore().catch((e) => {
  console.error(e);
  toast('Could not reach the scheduler database.', 'error');
});

