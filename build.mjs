// Bundles the browser app (shared rules engine + PDF export included) into one self-contained page.
// Usage: node web/build.mjs [esbuild path]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const esbuild = process.argv[2] ?? 'esbuild';
mkdirSync(join(here, 'dist'), { recursive: true });
execFileSync(esbuild, [join(here, 'src/main.ts'), '--bundle', '--format=iife', '--target=es2020', '--minify', '--legal-comments=none', `--outfile=${join(here, 'dist/app.js')}`], { stdio: 'inherit' });
const js = readFileSync(join(here, 'dist/app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const css = readFileSync(join(here, 'src/styles.css'), 'utf8');
const page = `<title>Beach Patrol Scheduler</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700&family=Public+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap">
<style>
${css}
</style>
<div id="app"><div class="center-screen"><p>Loading the scheduler…</p></div></div>
<div id="modal" hidden></div>
<div id="toasts" aria-live="polite"></div>
<script>
${js}
</script>
`;
// claude.ai artifact version (the host adds the document skeleton) …
writeFileSync(join(here, 'dist/beach-patrol-scheduler.html'), page);
// … and the full page the scheduler's own server sends.
writeFileSync(join(here, 'dist/index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
</head>
<body>
${page}</body>
</html>
`);
console.log(`page: ${(page.length / 1024).toFixed(0)} KB`);
