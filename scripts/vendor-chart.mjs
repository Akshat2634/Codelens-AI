#!/usr/bin/env node
// Refresh the vendored Chart.js UMD bundle (src/vendor/chart.umd.min.js) from
// the installed chart.js devDependency. Runs automatically on `prepublishOnly`
// so a chart.js version bump can't ship a stale vendored copy, and can be run
// by hand after upgrading chart.js: `npm run vendor:chart`.
//
// The bundle is committed to the repo and shipped inside the package so the
// dashboard's <script src="/vendor/chart.umd.min.js"> works without depending
// on chart.js being resolvable at the user's runtime (npx caches have shipped
// partial node_modules where require.resolve succeeds but the file is absent).
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// chart.js's exports map doesn't expose ./dist subpaths, so resolve the main
// entry (dist/chart.cjs) and take the UMD bundle sitting beside it.
const distDir = path.dirname(require.resolve('chart.js'));
const src = path.join(distDir, 'chart.umd.min.js');
const destDir = path.join(__dirname, '..', 'src', 'vendor');
const dest = path.join(destDir, 'chart.umd.min.js');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

const version = JSON.parse(
  readFileSync(path.join(distDir, '..', 'package.json'), 'utf8')
).version;
console.log(`Vendored chart.js@${version} → src/vendor/chart.umd.min.js`);
