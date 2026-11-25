// Admin accounts (up to 10), settings and recent activity.

import { rerender } from '../app-state.ts';
import { currentAdmin, hashPassword, IDENTIFIER, MAX_ADMINS, me } from '../model.ts';
import { audit, deleteAdmin, saveAdmin, saveSettings, state, StoreError, type Admin } from '../store.ts';
import { $, $$, html, icon, modal, newId, raw, toast, type Raw } from '../util.ts';

async function run(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (e) {
    toast(e instanceof StoreError ? e.message : (e as Error).message || 'Could not save.', 'error');
  }
}

const admins = () => [...state.admins.values()].sort((a, b) => a.identifier.localeCompare(b.identifier));
const overriders = (exclude: string) => admins().filter((a) => a.active && a.canOverride && a.id !== exclude).length;

export const adminsView = {
  render(): Raw {
    const list = admins();
    const self = currentAdmin!;
    return html`<div class="page">
      <header class="topbar"><div><div class="eyebrow">Admins &amp; settings</div><h1 class="h1">Scheduler access</h1></div><div class="spacer"></div><span class="muted">${list.length} of ${MAX_ADMINS} admin accounts</span>
        <button type="button" class="btn primary" id="ad-add" ${list.length >= MAX_ADMINS ? raw('disabled title="The scheduler allows at most 10 admin accounts"') : ''}>${icon('plus', 14)} Add admin</button></header>
      <div class="page-body">
        <section class="card flush">
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th scope="col">Identifier</th><th scope="col">Name</th><th scope="col">Can approve overrides</th><th scope="col">Status</th><th scope="col">Last sign-in</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
            <tbody>${list.map(
              (a) => html`<tr class="${a.active ? '' : 'inactive'}">
                <td><span class="mono strong">${a.identifier}</span>${a.id === self.id ? html` <span class="tag def">You</span>` : ''}</td>
                <td>${a.displayName}</td>
                <td><label class="switch"><input type="checkbox" data-ovr="${a.id}" ${a.canOverride ? raw('checked') : ''}><span class="track" aria-hidden="true"></span>${a.canOverride ? 'Yes' : 'No'}</label></td>
                <td>${a.active ? html`<span class="tag ok">Active</span>` : html`<span class="tag">Deactivated</span>`}</td>
                <td class="muted small">${a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : 'Never'}</td>
                <td class="nowrap"><button type="button" class="btn tiny" data-pw="${a.id}">Reset password</button>
                  ${a.id === self.id ? '' : html`<button type="button" class="btn tiny" data-act="${a.id}">${a.active ? 'Deactivate' : 'Activate'}</button><button type="button" class="icon-btn" data-del="${a.id}" aria-label="Delete ${a.identifier}">${icon('trash', 14)}</button>`}</td>
              </tr>`,
            )}</tbody></table></div>
        </section>
        <p class="info small">${icon('check', 13)} <span>Lifeguards never sign in. Each admin signs in with their own identifier, and every change is recorded under it. Who can open this scheduler at all is set by the page's Share settings on claude.ai.</span></p>
        <div class="cards2">
          <section class="card">
            <h3 class="h3">Settings</h3>
            <label class="field"><span>Patrol name (shown on screens and PDFs)</span><input id="st-name" class="input" value="${state.settings.patrolName}" maxlength="80"></label>
            <label class="switch"><input type="checkbox" id="st-ovr" ${state.settings.overridesEnabled ? raw('checked') : ''} ${self.canOverride ? '' : raw('disabled')}><span class="track" aria-hidden="true"></span>Allow supervisor overrides</label>
            <p class="muted small">When on, admins who can approve overrides may assign someone who is off, unqualified or double-booked, with a reason. ${self.canOverride ? '' : 'Only an admin who can approve overrides may change this.'}</p>
          </section>
          <section class="card">
            <h3 class="h3">Recent activity</h3>
            <ul class="activity" data-keep-scroll="activity">${state.audit.slice(0, 40).map((e) => html`<li><span class="mono small strong">${e.admin}</span> <span>${e.action}</span>${e.detail ? html` <span class="muted small">· ${e.detail}</span>` : ''}<span class="muted small when">${new Date(e.at).toLocaleString()}</span></li>`)}</ul>
            ${state.audit.length ? '' : html`<p class="muted small">Nothing yet.</p>`}
          </section>
        </div>
      </div>
    </div>`;
  },
  bind(root: HTMLElement): void {
    const add = $('#ad-add', root) as HTMLButtonElement;
    add.onclick = () => adminForm();
    $$<HTMLInputElement>('[data-ovr]', root).forEach(
      (c) =>
        (c.onchange = () => {
          const a = state.admins.get(c.dataset.ovr!)!;
          if (!c.checked && overriders(a.id) === 0) {
            c.checked = true;
            return toast('At least one active admin must be able to approve overrides.', 'warn');
          }
          run(() => saveAdmin({ ...a, canOverride: c.checked }), `${a.identifier} ${c.checked ? 'can' : 'can no longer'} approve overrides.`);
          audit(me(), 'Changed override permission', `${a.identifier}: ${c.checked ? 'yes' : 'no'}`);
        }),
    );
    $$('[data-act]', root).forEach(
      (b) =>
        (b.onclick = () => {
          const a = state.admins.get(b.dataset.act!)!;
          if (a.active && a.canOverride && overriders(a.id) === 0) return toast('At least one active admin must be able to approve overrides.', 'warn');
          run(() => saveAdmin({ ...a, active: !a.active }), a.active ? `${a.identifier} deactivated.` : `${a.identifier} activated.`);
          audit(me(), a.active ? 'Deactivated admin' : 'Activated admin', a.identifier);
        }),
    );
    $$('[data-del]', root).forEach(
      (b) =>
        (b.onclick = () => {
          const a = state.admins.get(b.dataset.del!)!;
          if (a.active && a.canOverride && overriders(a.id) === 0) return toast('At least one active admin must be able to approve overrides.', 'warn');
          modal(html`<h2 class="h2">Delete ${a.identifier}?</h2><p>${a.displayName} will no longer be able to sign in. Their past changes stay in the activity log.</p><div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn danger" id="dd-go">Delete</button></div>`, (r, close) => {
            ($('#dd-go', r) as HTMLButtonElement).onclick = () => {
              close();
              run(() => deleteAdmin(a.id), `${a.identifier} deleted.`);
              audit(me(), 'Deleted admin', a.identifier);
            };
          });
        }),
    );
    $$('[data-pw]', root).forEach((b) => (b.onclick = () => passwordForm(state.admins.get(b.dataset.pw!)!)));
    ($('#st-name', root) as HTMLInputElement).onchange = (e) => {
      const v = (e.target as HTMLInputElement).value.trim();
      if (v) run(() => saveSettings({ ...state.settings, patrolName: v }), 'Patrol name saved.');
    };
    ($('#st-ovr', root) as HTMLInputElement).onchange = (e) => {
      const on = (e.target as HTMLInputElement).checked;
      run(() => saveSettings({ ...state.settings, overridesEnabled: on }), on ? 'Overrides allowed.' : 'Overrides turned off.');
      audit(me(), on ? 'Allowed overrides' : 'Turned off overrides');
    };
  },
};

function adminForm() {
  const n = admins().length + 1;
  modal(
    html`<h2 class="h2">Add admin</h2>
      <div class="row2 fixed"><label class="field"><span>Identifier</span><input id="na-id" class="input mono" value="ADM${String(n).padStart(2, '0')}" maxlength="20"></label><label class="field"><span>Display name</span><input id="na-dn" class="input" maxlength="80" autofocus></label></div>
      <label class="field"><span>Temporary password (8+ characters)</span><input id="na-pw" class="input" type="password" autocomplete="new-password"></label>
      <label class="check"><input type="checkbox" id="na-ovr"> Can approve supervisor overrides</label>
      <p class="error" id="na-err" hidden></p>
      <div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="na-go">Add admin</button></div>`,
    (root, close) => {
      ($('#na-go', root) as HTMLButtonElement).onclick = async () => {
        const v = (id: string) => ($(`#${id}`, root) as HTMLInputElement).value.trim();
        const err = $('#na-err', root)!;
        const fail = (m: string) => ((err.textContent = m), (err.hidden = false));
        const identifier = v('na-id').toUpperCase();
        if (admins().length >= MAX_ADMINS) return fail(`The scheduler allows at most ${MAX_ADMINS} admin accounts.`);
        if (!IDENTIFIER.test(identifier)) return fail('The identifier can use 2–20 letters, digits, - or _.');
        if (admins().some((a) => a.identifier.toUpperCase() === identifier)) return fail(`${identifier} is already taken.`);
        if (($('#na-pw', root) as HTMLInputElement).value.length < 8) return fail('The password needs at least 8 characters.');
        const { salt, hash } = await hashPassword(($('#na-pw', root) as HTMLInputElement).value);
        const a: Admin = { id: String(newId()), identifier, displayName: v('na-dn') || identifier, salt, hash, canOverride: ($('#na-ovr', root) as HTMLInputElement).checked, active: true, createdAt: new Date().toISOString() };
        close();
        await run(() => saveAdmin(a), `${identifier} added. Share the identifier and temporary password with them.`);
        audit(me(), 'Added admin', identifier);
        rerender(true);
      };
    },
  );
}

function passwordForm(a: Admin) {
  modal(
    html`<h2 class="h2">${a.id === currentAdmin?.id ? 'Change your password' : `Reset password for ${a.identifier}`}</h2>
      <label class="field"><span>New password (8+ characters)</span><input id="pw-1" class="input" type="password" autocomplete="new-password" autofocus></label>
      <label class="field"><span>Repeat it</span><input id="pw-2" class="input" type="password" autocomplete="new-password"></label>
      <p class="error" id="pw-err" hidden></p>
      <div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="pw-go">Save password</button></div>`,
    (root, close) => {
      ($('#pw-go', root) as HTMLButtonElement).onclick = async () => {
        const p1 = ($('#pw-1', root) as HTMLInputElement).value;
        const err = $('#pw-err', root)!;
        if (p1.length < 8) return ((err.textContent = 'Use at least 8 characters.'), (err.hidden = false));
        if (p1 !== ($('#pw-2', root) as HTMLInputElement).value) return ((err.textContent = 'The two passwords do not match.'), (err.hidden = false));
        const { salt, hash } = await hashPassword(p1);
        close();
        await run(() => saveAdmin({ ...a, salt, hash }), 'Password saved.');
        audit(me(), 'Reset password', a.identifier);
      };
    },
  );
}
