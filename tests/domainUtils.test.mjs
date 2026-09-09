import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { build } from 'esbuild';

const buildDir = await mkdtemp(path.join(tmpdir(), 'cf-imgbed-domain-test-'));
const bundlePath = path.join(buildDir, 'domainUtils.mjs');
after(() => rm(buildDir, { recursive: true, force: true }));
await build({
	entryPoints: [path.resolve('src/utils/domainUtils.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	outfile: bundlePath
});
const { getEffectiveExcludedDomains, getOwnImageBedHostnames, isUrlExcluded } = await import(pathToFileURL(bundlePath).href);

test('custom return base URL domain is excluded alongside the API domain', () => {
	const domains = getEffectiveExcludedDomains('http://192.168.2.191:7658', ['cdn.other.com'], 'https://img.example.com/');
	assert.deepEqual(domains, ['cdn.other.com', '192.168.2.191', 'img.example.com']);
	assert.equal(isUrlExcluded('https://img.example.com/file/a.png', domains), true);
	assert.equal(isUrlExcluded('http://192.168.2.191:7658/file/a.png', domains), true);
	assert.equal(isUrlExcluded('https://elsewhere.com/a.png', domains), false);
});

test('own hostnames are deduplicated and tolerate an empty custom base URL', () => {
	assert.deepEqual(getOwnImageBedHostnames('https://img.example.com', 'https://img.example.com/prefix'), ['img.example.com']);
	assert.deepEqual(getOwnImageBedHostnames('https://img.example.com', ''), ['img.example.com']);
	assert.deepEqual(getOwnImageBedHostnames('', ''), []);
});
