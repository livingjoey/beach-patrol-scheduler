// Certification criteria engine.
//
// A rule is a tree:
//   { "cert": "EMT" }                      lifeguard holds EMT
//   { "any": [rule, rule, …] }             ANY / OR  – at least one child is true
//   { "all": [rule, rule, …] }             ALL / AND – every child is true
//
// Example: (EMT or EMT2 or PMD) and PWC3
//   { "all": [ { "any": [{"cert":"EMT"},{"cert":"EMT2"},{"cert":"PMD"}] }, { "cert": "PWC3" } ] }
//
// A bare string "EMT" is accepted as shorthand for { "cert": "EMT" }.
// An empty { "all": [] } means "no requirement".
// No certification implies another. Equivalencies apply only when explicitly enabled.

export type Rule = { cert: string } | { all: Rule[] } | { any: Rule[] };

export interface Equivalency {
  holder: string;
  satisfies: string;
}

export class RuleError extends Error {
  path: string;
  constructor(message: string, path: string) {
    super(`${message} (at ${path})`);
    this.path = path;
  }
}

const MAX_DEPTH = 5;
const MAX_ITEMS = 50;

export function parseRule(input: unknown, knownCerts: ReadonlySet<string>, path = 'rule', depth = 0): Rule {
  if (depth > MAX_DEPTH) throw new RuleError(`Rules can be nested at most ${MAX_DEPTH} levels`, path);
  if (typeof input === 'string') input = { cert: input };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RuleError('Expected a rule object: {cert}, {any:[…]} or {all:[…]}', path);
  }
  const o = input as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 1) throw new RuleError('A rule must have exactly one of: cert, any, all', path);
  if ('cert' in o) {
    if (typeof o.cert !== 'string') throw new RuleError('cert must be a string', path);
    const code = o.cert.trim().toUpperCase();
    if (!knownCerts.has(code)) throw new RuleError(`Unknown certification "${o.cert}"`, path);
    return { cert: code };
  }
  const op = 'any' in o ? 'any' : 'all' in o ? 'all' : null;
  if (!op) throw new RuleError('A rule must have exactly one of: cert, any, all', path);
  const items = o[op];
  if (!Array.isArray(items)) throw new RuleError(`${op} must be an array`, path);
  if (items.length > MAX_ITEMS) throw new RuleError(`A group can hold at most ${MAX_ITEMS} items`, path);
  if (op === 'any' && items.length === 0) throw new RuleError('An ANY group needs at least one item', path);
  if (op === 'all' && items.length === 0 && depth > 0) throw new RuleError('An ALL group needs at least one item', path);
  const children = items.map((it, i) => parseRule(it, knownCerts, `${path}.${op}[${i}]`, depth + 1));
  return op === 'any' ? { any: children } : { all: children };
}

/** Held certifications plus anything granted by enabled equivalencies (transitively). */
export function effectiveCerts(held: Iterable<string>, equivalencies: readonly Equivalency[]): Set<string> {
  const out = new Set(held);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of equivalencies) {
      if (out.has(e.holder) && !out.has(e.satisfies)) {
        out.add(e.satisfies);
        changed = true;
      }
    }
  }
  return out;
}

export function evaluate(rule: Rule | null, certs: ReadonlySet<string>): boolean {
  if (!rule) return true;
  if ('cert' in rule) return certs.has(rule.cert);
  if ('any' in rule) return rule.any.some((r) => evaluate(r, certs));
  return rule.all.every((r) => evaluate(r, certs));
}

/** Plain-language summary, e.g. "(EMT or EMT2 or PMD) and PWC3". */
export function describe(rule: Rule | null): string {
  if (!rule || ('all' in rule && rule.all.length === 0)) return 'No requirement';
  return describeInner(rule, null);
}

function describeInner(rule: Rule, parent: 'any' | 'all' | null): string {
  if ('cert' in rule) return rule.cert;
  const op = 'any' in rule ? 'any' : 'all';
  const items = 'any' in rule ? rule.any : rule.all;
  if (items.length === 1) return describeInner(items[0], parent);
  const text = items.map((r) => describeInner(r, op)).join(op === 'any' ? ' or ' : ' and ');
  return parent && parent !== op ? `(${text})` : text;
}

/** Which parts of the rule a lifeguard is missing, in plain language. Empty when qualified. */
export function missing(rule: Rule | null, certs: ReadonlySet<string>): string[] {
  if (!rule || evaluate(rule, certs)) return [];
  if ('all' in rule) return rule.all.filter((r) => !evaluate(r, certs)).map((r) => describeNeed(r));
  return [describeNeed(rule)];
}

function describeNeed(rule: Rule): string {
  if ('cert' in rule) return rule.cert;
  if ('any' in rule && rule.any.every((r) => 'cert' in r)) {
    return `one of ${rule.any.map((r) => (r as { cert: string }).cert).join(', ')}`;
  }
  return describe(rule);
}

export function certsInRule(rule: Rule | null, out = new Set<string>()): Set<string> {
  if (!rule) return out;
  if ('cert' in rule) out.add(rule.cert);
  else for (const r of 'any' in rule ? rule.any : rule.all) certsInRule(r, out);
  return out;
}
