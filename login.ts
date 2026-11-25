// Sign-in landing page: agency emblem, admin account login, and lifeguard quick access.
// Quick access only checks the ID for now; the individual schedule view is not built yet.

import { BRAND, LOGO_DATA_URI } from '../branding.ts';
import { html, raw, type Raw } from '../util.ts';

const svg = (paths: string, size = 20) =>
  raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`);

const I = {
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.2-4 4.3-6 8-6s6.8 2 8 6"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.2"/>'),
  eye: svg('<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.6A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 4.1M6.6 6.7A16.6 16.6 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9.6 9.6 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  badge: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9.5 3.5v3M14.5 3.5v3"/><circle cx="8.5" cy="11.5" r="2"/><path d="M5.5 16.5c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4M14 10.5h4M14 13.5h4"/>', 22),
  calendar: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><path d="M7.5 13h1M11.5 13h1M15.5 13h1M7.5 16.5h1M11.5 16.5h1M15.5 16.5h1"/>', 22),
};

// Decorative shoreline: layered waves and a lifeguard tower silhouette.
const WAVES = raw(`<svg class="ld-waves" viewBox="0 0 1440 180" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 92 C 180 60, 320 60, 470 82 S 760 118, 930 92 S 1230 50, 1440 74 V180 H0Z" fill="var(--ld-wave1)"/>
  <path d="M0 122 C 210 96, 380 100, 560 118 S 860 146, 1060 124 S 1320 98, 1440 112 V180 H0Z" fill="var(--ld-wave2)"/>
  <path d="M0 152 C 240 134, 420 138, 640 150 S 980 168, 1180 154 S 1370 140, 1440 146 V180 H0Z" fill="var(--ld-wave3)"/>
</svg>`);

const TOWER = raw(`<svg class="ld-tower" viewBox="0 0 240 230" aria-hidden="true">
  <g fill="none" stroke="var(--ld-tower)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M150 8 V58"/>
    <path d="M70 84 L60 214 M174 84 L184 214 M98 84 L94 214 M146 84 L150 214"/>
    <path d="M64 150 L180 150 M62 182 L182 182 M64 150 L182 182 M180 150 L62 182"/>
    <path d="M60 100 L184 100"/>
    <path d="M10 214 L68 150 M22 214 L76 160"/>
    <path d="M18 205 h8 M30 192 h8 M42 179 h8 M54 166 h8"/>
  </g>
  <path d="M150 10 L182 20 L150 32 Z" fill="var(--ld-tower)"/>
  <path d="M52 66 L192 66 L184 56 L60 56 Z" fill="var(--ld-tower)"/>
  <rect x="68" y="66" width="108" height="34" fill="var(--ld-tower)"/>
  <rect x="82" y="72" width="22" height="16" fill="var(--ld-bg)"/>
  <rect x="112" y="72" width="22" height="16" fill="var(--ld-bg)"/>
  <rect x="142" y="72" width="22" height="16" fill="var(--ld-bg)"/>
  <path d="M120 214 q10 -16 20 0 M196 214 q8 -20 16 0 M206 214 q6 -14 12 0" fill="none" stroke="var(--ld-tower)" stroke-width="3" stroke-linecap="round"/>
</svg>`);

export function loginPage(): Raw {
  return html`<div class="ld">
    <div class="ld-inner">
      <img class="ld-logo" src="${LOGO_DATA_URI}" alt="${BRAND.logoAlt}" width="${BRAND.logoWidth}" height="${BRAND.logoHeight}">
      <h1 class="ld-title">${BRAND.title}</h1>
      <div class="ld-sub" role="presentation"><span>${BRAND.subtitle}</span></div>

      <form class="ld-card" id="login" novalidate aria-labelledby="ld-login-h">
        <h2 class="ld-eyebrow" id="ld-login-h">Account login</h2>
        <label class="ld-field">
          <span class="sr">Username</span>
          <span class="ld-ic">${I.user}</span>
          <input id="login-id" placeholder="Username" autocomplete="username" autocapitalize="characters" spellcheck="false" required>
        </label>
        <label class="ld-field">
          <span class="sr">Password</span>
          <span class="ld-ic">${I.lock}</span>
          <input id="login-pw" type="password" placeholder="Password" autocomplete="current-password" required>
          <button type="button" class="ld-eye" id="login-eye" aria-label="Show password" aria-pressed="false">${I.eyeOff}</button>
        </label>
        <p class="ld-error" id="login-err" role="alert" hidden></p>
        <button type="submit" class="ld-btn ld-btn-login" id="login-go">Log in</button>
      </form>

      <div class="ld-divider" role="presentation"><span>Quick access</span></div>

      <form class="ld-quick" id="quick" novalidate>
        <label class="ld-field ld-quick-id">
          <span class="sr">Your lifeguard number</span>
          <span class="ld-ic">${I.badge}</span>
          <span class="ld-prefix" aria-hidden="true">LG</span>
          <input id="quick-id" placeholder="Enter your number" autocomplete="off" inputmode="numeric" pattern="[0-9]*" spellcheck="false" maxlength="4">
        </label>
        <button type="submit" class="ld-btn ld-btn-quick">${I.calendar}<span>View schedule</span></button>
        <p class="ld-quick-msg" id="quick-msg" role="status" hidden></p>
      </form>
    </div>
    ${TOWER}
    ${WAVES}
  </div>`;
}

export function bindLogin(root: HTMLElement, signIn: (id: string, pw: string) => Promise<void>): void {
  const id = root.querySelector('#login-id') as HTMLInputElement;
  const pw = root.querySelector('#login-pw') as HTMLInputElement;
  const err = root.querySelector('#login-err') as HTMLElement;
  const go = root.querySelector('#login-go') as HTMLButtonElement;
  const eye = root.querySelector('#login-eye') as HTMLButtonElement;

  eye.addEventListener('click', () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    eye.innerHTML = (show ? I.eye : I.eyeOff).value;
    pw.focus();
  });

  root.querySelector('#login')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!id.value.trim() || !pw.value) {
      err.textContent = 'Enter your username and password.';
      err.hidden = false;
      (id.value.trim() ? pw : id).focus();
      return;
    }
    go.disabled = true;
    go.textContent = 'Signing in…';
    try {
      await signIn(id.value, pw.value);
    } catch (x) {
      err.textContent = (x as Error).message || 'Could not sign in. Try again.';
      err.hidden = false;
      go.disabled = false;
      go.textContent = 'Log in';
      pw.select();
    }
  });

  const qid = root.querySelector('#quick-id') as HTMLInputElement;
  const qmsg = root.querySelector('#quick-msg') as HTMLElement;
  // Only the number is typed; "LG" is shown in front. Pasting "LG31" still works.
  qid.addEventListener('input', () => {
    qid.value = qid.value.replace(/^\s*lg/i, '').replace(/\D/g, '').slice(0, 4);
    qmsg.hidden = true;
  });
  root.querySelector('#quick')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = qid.value.trim();
    qmsg.classList.remove('ok');
    if (!n) {
      qmsg.textContent = 'Enter your number to see your schedule.';
    } else {
      const lg = `LG${Number(n)}`;
      // The individual schedule view isn't built yet.
      qmsg.textContent = `Individual schedules are coming soon (${lg}).`;
      qmsg.classList.add('ok');
    }
    qmsg.hidden = false;
  });

  id.focus();
}
