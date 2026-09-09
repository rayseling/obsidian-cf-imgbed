import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { build } from 'esbuild';

const buildDir = await mkdtemp(path.join(tmpdir(), 'cf-imgbed-refs-test-'));
const bundlePath = path.join(buildDir, 'imageReferences.mjs');
after(() => rm(buildDir, { recursive: true, force: true }));
await build({
	entryPoints: [path.resolve('src/utils/imageReferences.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	outfile: bundlePath
});
const {
	computeExcludedRanges,
	extractMarkdownAndWikiImageReferences,
	extractPlainImageUrlReferences
} = await import(pathToFileURL(bundlePath).href);

const paths = (refs) => refs.map((ref) => ref.path);

test('images inside fenced code blocks are not extracted', () => {
	const content = [
		'![real](real.png)',
		'```md',
		'![example](example.png)',
		'![[wiki-example.png]]',
		'```',
		'~~~',
		'![tilde](tilde.png)',
		'~~~',
		'![[after.png]]'
	].join('\n');
	assert.deepEqual(paths(extractMarkdownAndWikiImageReferences(content)), ['real.png', 'after.png']);
});

test('a longer closing fence is required to close a longer opening fence', () => {
	const content = ['````', '```', '![still-code](a.png)', '```', '````', '![out](b.png)'].join('\n');
	assert.deepEqual(paths(extractMarkdownAndWikiImageReferences(content)), ['b.png']);
});

test('an unclosed fence excludes everything after it', () => {
	const content = ['![before](a.png)', '```', '![inside](b.png)'].join('\n');
	assert.deepEqual(paths(extractMarkdownAndWikiImageReferences(content)), ['a.png']);
});

test('images inside inline code and comments are not extracted', () => {
	const content = [
		'Use `![alt](inline.png)` to embed. ``![[double.png]]`` too.',
		'<!-- ![commented](html.png) -->',
		'%% ![[obsidian.png]] %%',
		'![kept](kept.png)'
	].join('\n');
	assert.deepEqual(paths(extractMarkdownAndWikiImageReferences(content)), ['kept.png']);
});

test('an unmatched backtick does not swallow the rest of the line', () => {
	const content = 'a ` b ![kept](kept.png)';
	assert.deepEqual(paths(extractMarkdownAndWikiImageReferences(content)), ['kept.png']);
});

test('plain image URLs inside code are ignored', () => {
	const content = ['`https://a.example/in-code.png`', 'https://a.example/plain.png'].join('\n');
	assert.deepEqual(paths(extractPlainImageUrlReferences(content)), ['https://a.example/plain.png']);
});

test('excluded ranges cover fences, inline code and comments with correct offsets', () => {
	const content = 'x `y` <!-- z --> %%w%%\n```\ncode\n```\n';
	const ranges = computeExcludedRanges(content);
	assert.deepEqual(
		ranges.map((range) => content.slice(range.start, range.end)),
		['`y`', '<!-- z -->', '%%w%%', '```\ncode\n```\n']
	);
});

test('reference offsets remain correct when exclusions are present', () => {
	const content = '`skip` ![[a.png|200]] and ![b](b.png "title")';
	const refs = extractMarkdownAndWikiImageReferences(content);
	for (const ref of refs) {
		assert.equal(content.slice(ref.index, ref.index + ref.length), ref.source);
	}
	assert.deepEqual(paths(refs), ['a.png', 'b.png']);
});

test('a wiki embed followed by a markdown image on the same line yields two separate references', () => {
	const content = '![[a.png|200]] and ![b](b.png)';
	const refs = extractMarkdownAndWikiImageReferences(content);
	assert.deepEqual(refs.map((ref) => [ref.syntax, ref.path, ref.source]), [
		['wiki', 'a.png', '![[a.png|200]]'],
		['markdown', 'b.png', '![b](b.png)']
	]);
});

test('a closing fence may not carry an info string', () => {
	const content = ['```md', '![a](a.png)', '```not-a-closing-fence', '![b](b.png)', '```', '![c](c.png)'].join('\n');
	assert.deepEqual(paths(extractMarkdownAndWikiImageReferences(content)), ['c.png']);
});

test('indented code blocks (4 spaces / tab after a blank line) are excluded, list continuations are not', () => {
	const content = [
		'![top](top.png)',
		'',
		'    ![indented](indented.png)',
		'',
		'    ![still-indented](still.png)',
		'![after](after.png)',
		'- item',
		'    ![list-child](child.png)',
		'',
		'\t![tab](tab.png)',
		'![end](end.png)'
	].join('\n');
	assert.deepEqual(paths(extractMarkdownAndWikiImageReferences(content)), ['top.png', 'after.png', 'child.png', 'end.png']);
});
