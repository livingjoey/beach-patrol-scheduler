# Beach Patrol Scheduler

**To put it on the web, follow [DEPLOY.md](DEPLOY.md)** (Render, about 20 minutes).

`npm start` runs the scheduler's website. It serves the web app from `web/dist/index.html`, stores its data in SQLite, and checks admin sign-in on the server (`src/hosted.ts`). Run it locally:

```bash
npm install
SETUP_CODE=pick-one npm start      # open http://localhost:3000 and complete setup
```

The rest of this README describes the separate REST API. It is off unless `ENABLE_REST_API=true`, keeps its own tables, and is not needed by the web app.

---

# REST API (optional)

REST API for the Beach Patrol Scheduler: personnel and certifications, time off, the assignment directory with configurable staffing slots, saved criteria presets, the weekly schedule (Saturday–Friday), Auto-Fill and PDF export.

Built with Node.js + TypeScript. It uses Node's built-in HTTP server, SQLite (`node:sqlite`) and test runner. The only runtime dependency is `pdf-lib`, which draws the PDFs.

## Quick start

Requires **Node 22.18 or newer**, which runs TypeScript directly with no build step.

```bash
npm install
cp .env.example .env          # set AUTH_SECRET to a long random string
npm run seed                  # certifications, example presets, assignments, first admin
# or: npm run seed:demo       # same, plus 76 placeholder lifeguards to try things out
ENABLE_REST_API=true npm start   # API under http://localhost:3000/api
npm test                      # 29 unit, API and hosting tests
npm run typecheck
```

`npm run seed` prints the first admin's sign-in, identifier **ADM01**, and a random password. You can choose the password instead with `SEED_ADMIN_PASSWORD`. Change it after you first sign in.

## Who signs in

Only administrators use the scheduler. Lifeguards never sign in.

- At most **10 admin accounts**. Each one has its own **identifier** (for example ADM01 to ADM10) and its own password.
- Any admin can do the scheduling and setup work.
- Admins with **`canOverride`** can approve rule exceptions: assigning someone who is off, unqualified or already working that day. They have to give a reason, and it's recorded with the entry. The system always keeps at least one active admin who can approve overrides.
- Overrides as a whole can be switched off in Settings.
- After 5 failed sign-ins, an identifier is locked for 15 minutes.

Send `Authorization: Bearer <token>` with every request. You get the token from `POST /api/auth/login`.

## Key rules

- **Patrol week** runs Saturday through Friday. Any date given as `week=` is rounded back to its Saturday.
- **Certifications are independent.** Holding EMT2 does **not** count as holding EMT, unless an admin turns on that equivalency at `PUT /api/certifications/equivalencies`. A few possible equivalencies are seeded, all switched off.
- **Criteria rules** combine ANY (OR) and ALL (AND) groups, nested as deep as you need:
  `{"all":[{"any":["EMT","EMT2","PMD"]},"PWC3"]}` → "(EMT or EMT2 or PMD) and PWC3"
- **Slot criteria** can follow the assignment's default preset (`mode: default`), use a different saved preset (`mode: preset`), or have a one-off rule for that slot only (`mode: custom`). Editing a preset changes every slot that uses it. Custom rules are never touched.
- **Regular days off** repeat every week. **Date overrides** cover one-time changes: vacation, approved leave, training, other, or an extra working day. They never change the regular pattern.
- **Closed** stands and units can't be staffed, and closing one asks first if people are already assigned to it. **Locked** entries are never moved or cleared by Auto-Fill or by clearing a week.
- **Shift overlap:** a lifeguard can't be on two assignments that overlap on the same day. Assignments without set shift times count as full-day.
- The seeded presets (Basic Qualified, Medical Response Qualified, PWC Rescuer, PWC Operator, Boat Crew, Supervisor) are **examples only**. Set the real requirements yourself.

## Auto-Fill

`POST /api/schedule/autofill` with `{ weekStart, scope: "week" | "day", date?, onlyEmpty: true, dryRun: true }`.

It only places lifeguards who are active and available that date, after regular days off and date overrides. Each person must meet that slot's criteria, the stand or unit must be open, and locked entries are kept. For each day it finds the largest possible set of assignments, filling the hardest slots first and giving shifts to people with the fewest this week. Use `dryRun: true` to preview the results, including which slots it can't fill and why.

## PDF export

`GET /api/export/schedule.pdf?week=2027-06-05&layout=…` (`GET /api/export/options` lists the choices for an export dialog)

| layout | What it is | Default orientation |
|---|---|---|
| `week-grid` | Days down the side, stands and units across, like the Schedule Builder | landscape |
| `daily-sheet` | One page (or two) per day listing every assignment, slot and lifeguard, plus who's off. For posting at headquarters | portrait |
| `roster` | One row per lifeguard showing each day's assignment or why they're off, with a shift count | landscape |
| `by-assignment` | One block per stand or unit, slots down the side and days across | landscape |

Options:

- `paper`: letter, legal, tabloid, a4 or a3
- `orientation`: auto, portrait or landscape
- `kinds`: which groups to include (stand, medical, pwc, boat, extra)
- `days`: which days to include (sat … fri)
- On/off settings (true/false): `names`, `colors` (personnel label colors), `criteria`, `empty` (prints open slots as OPEN), `watermark` (marks unpublished weeks DRAFT)
- `title`: a custom title

Each page has a header and footer showing the week, whether it's published or a draft, which admin generated it, and page numbers.

## API overview

| Area | Endpoints |
|---|---|
| Auth and admins | `POST /api/auth/login` · `GET /api/me` · `POST /api/me/password` · `GET/POST /api/admins` · `PATCH/DELETE /api/admins/:id` · `GET/PATCH /api/settings` |
| Personnel | `GET/POST /api/personnel` · `GET/PATCH/DELETE /api/personnel/:id` · `PUT/DELETE /api/personnel/:id/certifications/:code` · `GET /api/personnel/:id/qualifications` · `GET /api/personnel/:id/shifts?week=` |
| Certifications | `GET/POST /api/certifications` · `PATCH /api/certifications/:code` · `PUT /api/certifications/equivalencies` |
| Time off | `GET /api/availability?view=week\|pattern&week=` · `PUT /api/availability/pattern` · `POST /api/availability/day` · `GET/POST /api/time-off` · `PATCH/DELETE /api/time-off/:id` |
| Presets | `GET/POST /api/presets` · `GET/PATCH/DELETE /api/presets/:id` · `POST /api/presets/preview` |
| Assignments and slots | `GET/POST /api/assignments` · `GET/PATCH/DELETE /api/assignments/:id` · `POST /api/assignments/:id/slots` · `PUT …/slot-count` · `PUT …/slots/order` · `POST …/apply-preset` · `PATCH/DELETE /api/slots/:id` · `POST /api/slots/:id/save-as-preset` |
| Schedule | `GET /api/schedule/week?start=` · `GET /api/schedule/candidates?date=&slotId=` · `POST /api/schedule/check` · `PUT /api/schedule/entries` · `PATCH/DELETE /api/schedule/entries/:id` · `PUT /api/schedule/day-status` · `POST /api/schedule/autofill` · `POST /api/schedule/copy-week` · `POST /api/schedule/clear` |
| Publishing and audit | `GET /api/weeks/:start` · `POST /api/weeks/:start/publish` · `POST /api/weeks/:start/unpublish` · `GET /api/audit` |
| Export | `GET /api/export/options` · `GET /api/export/schedule.pdf` |

Errors always come back as `{ "error": { "code", "message", "details" } }`. For a drop that breaks a rule, the API answers `409 needs_override` and lists the issues, so the interface can show its warning and ask for a supervisor's reason.

### Drag-and-drop example

```http
PUT /api/schedule/entries
{ "date": "2027-06-05", "slotId": 2, "personnelId": 20 }                        // drop onto an empty slot
{ "date": "2027-06-05", "slotId": 2, "personnelId": 20, "moveFromEntryId": 88 } // drag from another slot
{ "date": "2027-06-05", "slotId": 2, "personnelId": 20, "replace": true }       // swap out whoever is there
{ "date": "2027-06-08", "slotId": 2, "personnelId": 31,
  "override": { "reason": "Short-staffed, approved by phone" } }                // supervisor override
```

## Project layout

```
src/
  server.ts, app.ts, config.ts
  db/          schema, SQLite helpers, seed
  domain/      pure logic: dates, criteria engine, availability, checks, Auto-Fill
  services/    loading data, building the week view, PDF rendering
  routes/      admins, personnel, availability, assignments, schedule, export
  http/        router, auth, validation
test/          unit + end-to-end API tests
```

## Moving to PostgreSQL later

Every table maps directly to PostgreSQL. All database access goes through `src/db/index.ts` (`all`, `get`, `run`, `tx`), so switching means swapping that file for a `pg` client and converting `schema.ts`.
