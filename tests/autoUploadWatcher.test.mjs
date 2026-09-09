import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { build } from 'esbuild';

// 最小 obsidian 桩：监听器只用到 TFile / Notice / Modal / Setting。
const obsidianStub = `
export class TAbstractFile { constructor(p) { this.path = p; this.name = p.split('/').pop(); } }
export class TFile extends TAbstractFile {
	constructor(p) { super(p); const dot = this.name.lastIndexOf('.'); this.extension = dot >= 0 ? this.name.slice(dot + 1) : ''; this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name; }
}
export class Notice { constructor(message) { (globalThis.__notices ??= []).push(String(message)); } }
export class Modal { constructor(app) { this.app = app; this.contentEl = { empty() {}, createEl() { return {}; } }; } open() { globalThis.__openedModal = this; this.onOpen?.(); } close() {} }
export class Setting { constructor() {} addButton(cb) { cb({ setButtonText() { return this; }, setCta() { return this; }, onClick(fn) { (globalThis.__modalButtons ??= []).push(fn); return this; } }); return this; } }
export class Plugin {}
`;
const stubObsidian = {
	name: 'stub-obsidian',
	setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: obsidianStub, loader: 'js' }));
	}
};

const buildDir = await mkdtemp(path.join(tmpdir(), 'cf-imgbed-watcher-test-'));
const bundlePath = path.join(buildDir, 'autoUploadWatcher.mjs');
after(() => rm(buildDir, { recursive: true, force: true }));
// 与监听器同一个 bundle 导出桩 TFile：监听器用 instanceof 判断，类必须是同一份
await build({
	stdin: {
		contents: "export * from './src/events/autoUploadWatcher.ts'; export { TFile } from 'obsidian';",
		resolveDir: process.cwd(),
		loader: 'js'
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	outfile: bundlePath,
	plugins: [stubObsidian]
});
const { AutoUploadWatcher, resolveAutoUploadScope, isPathInScope, TFile } = await import(pathToFileURL(bundlePath).href);

AutoUploadWatcher.minDebounceMs = 10;
const DEBOUNCE = 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createVault() {
	const handlers = {};
	const files = new Map();
	return {
		files,
		on(name, callback) {
			(handlers[name] ??= []).push(callback);
			return {};
		},
		emit(name, ...args) {
			for (const callback of handlers[name] ?? []) {
				callback(...args);
			}
		},
		add(filePath, content = '') {
			const file = new (this.TFileClass)(filePath);
			files.set(filePath, { file, content });
			return file;
		},
		getAbstractFileByPath(filePath) {
			return files.get(filePath)?.file ?? null;
		},
		getMarkdownFiles() {
			return Array.from(files.values()).map((entry) => entry.file).filter((file) => file.extension === 'md');
		},
		async read(file) {
			return files.get(file.path).content;
		},
		async cachedRead(file) {
			return files.get(file.path).content;
		},
		async process(file, fn) {
			const entry = files.get(file.path);
			const next = fn(entry.content);
			if (next !== entry.content) {
				entry.content = next;
				this.emit('modify', file);
			}
			return next;
		}
	};
}

function createImageHandler({ delayMs = 0, unresolved = [] } = {}) {
	return {
		calls: [],
		activeNow: 0,
		maxActive: 0,
		delayMs,
		unresolved,
		countUploadableImages(content) {
			return (content.match(/!\[\[local-[^\]]+\]\]/g) ?? []).length;
		},
		async uploadImagesInText(content, file, sourcePath, options) {
			this.calls.push({ content, sourcePath, options });
			this.activeNow++;
			this.maxActive = Math.max(this.maxActive, this.activeNow);
			if (this.delayMs > 0) {
				await sleep(this.delayMs);
			}
			this.activeNow--;
			const matches = content.match(/!\[\[local-[^\]]+\]\]/g) ?? [];
			const unresolvedLocal = this.unresolved.filter((name) => content.includes(name));
			const rewritten = content.replace(/!\[\[local-([^\]|]+)(?:\|[^\]]*)?\]\]/g, '![$1](https://img.example/$1)');
			return {
				content: rewritten,
				success: matches.length - unresolvedLocal.length,
				failed: unresolvedLocal.length,
				skipped: 0,
				unresolvedLocal
			};
		}
	};
}

async function setup(settingsOverrides = {}, handlerOptions = {}) {
	const vault = createVault();
	vault.TFileClass = TFile;
	const settings = {
		enableAutoUpload: true,
		autoUploadFolders: '',
		autoUploadWholeVault: false,
		autoUploadDebounceMs: DEBOUNCE,
		showUploadProgress: false,
		...settingsOverrides
	};
	const imageHandler = createImageHandler(handlerOptions);
	const plugin = {
		app: { vault },
		registerEvent() {}
	};
	const i18n = { t: (key, params) => `${key} ${JSON.stringify(params ?? {})}` };
	const watcher = new AutoUploadWatcher(plugin, imageHandler, () => settings, i18n);
	globalThis.__notices = [];
	globalThis.__modalButtons = [];
	return { vault, settings, imageHandler, watcher };
}

test('scope resolution: empty folders without whole-vault means no watching', () => {
	assert.equal(resolveAutoUploadScope({ autoUploadFolders: '', autoUploadWholeVault: false }), null);
	assert.deepEqual(resolveAutoUploadScope({ autoUploadFolders: ' /inbox/, clippings ', autoUploadWholeVault: false }), { wholeVault: false, folders: ['inbox', 'clippings'] });
	assert.deepEqual(resolveAutoUploadScope({ autoUploadFolders: 'inbox', autoUploadWholeVault: true }), { wholeVault: true, folders: [] });
	const scope = { wholeVault: false, folders: ['inbox'] };
	assert.equal(isPathInScope('inbox/a.md', scope), true);
	assert.equal(isPathInScope('inbox-archive/a.md', scope), false);
	assert.equal(isPathInScope('notes/a.md', scope), false);
});

test('nothing is processed when no scope is configured, even with auto-upload enabled', async () => {
	const { vault, imageHandler, watcher } = await setup();
	watcher.register();
	const note = vault.add('notes/a.md', '![[local-a.png]]');
	vault.emit('modify', note);
	await sleep(DEBOUNCE * 4);
	assert.equal(imageHandler.calls.length, 0);
	assert.equal(vault.files.get('notes/a.md').content, '![[local-a.png]]');
});

test('only notes inside watched folders are processed; whole-vault mode processes everything', async () => {
	const scoped = await setup({ autoUploadFolders: 'inbox' });
	scoped.watcher.register();
	const inside = scoped.vault.add('inbox/a.md', '![[local-a.png]]');
	const outside = scoped.vault.add('notes/b.md', '![[local-b.png]]');
	scoped.vault.emit('modify', inside);
	scoped.vault.emit('modify', outside);
	await sleep(DEBOUNCE * 4);
	assert.deepEqual(scoped.imageHandler.calls.map((call) => call.sourcePath), ['inbox/a.md']);
	assert.equal(scoped.vault.files.get('inbox/a.md').content, '![a.png](https://img.example/a.png)');
	assert.equal(scoped.vault.files.get('notes/b.md').content, '![[local-b.png]]');
	assert.equal(scoped.imageHandler.calls[0].options.allowAbsolutePaths, false);

	const whole = await setup({ autoUploadWholeVault: true });
	whole.watcher.register();
	const note = whole.vault.add('notes/b.md', '![[local-b.png]]');
	whole.vault.emit('modify', note);
	await sleep(DEBOUNCE * 4);
	assert.equal(whole.vault.files.get('notes/b.md').content, '![b.png](https://img.example/b.png)');
});

test('a change made while a note is being processed triggers a re-run instead of being dropped', async () => {
	const { vault, imageHandler, watcher } = await setup({ autoUploadFolders: 'inbox' }, { delayMs: 40 });
	watcher.register();
	const note = vault.add('inbox/a.md', '![[local-a.png]]');
	vault.emit('modify', note);
	await sleep(DEBOUNCE * 2); // 进入处理中
	assert.equal(imageHandler.calls.length, 1);

	// 用户在上传期间追加了一张新图
	vault.files.get('inbox/a.md').content = '![[local-a.png]]\n![[local-b.png]]';
	vault.emit('modify', note);
	await sleep(120);

	// 第一次写回被条件拒绝（磁盘内容已变），内容不丢；重跑后两张图都完成
	assert.ok(imageHandler.calls.length >= 2, `expected a re-run, got ${imageHandler.calls.length} calls`);
	assert.equal(vault.files.get('inbox/a.md').content, '![a.png](https://img.example/a.png)\n![b.png](https://img.example/b.png)');
});

test('a note whose image has not landed yet is re-run when the image file is created', async () => {
	const { vault, imageHandler, watcher } = await setup({ autoUploadFolders: 'inbox' }, { unresolved: ['local-late.png'] });
	watcher.register();
	const note = vault.add('inbox/a.md', '![[local-late.png]]');
	vault.emit('modify', note);
	await sleep(DEBOUNCE * 4);
	assert.equal(imageHandler.calls.length, 1);
	assert.equal(vault.files.get('inbox/a.md').content, '![[local-late.png]]');

	imageHandler.unresolved = [];
	const image = vault.add('inbox/local-late.png');
	vault.emit('create', image);
	await sleep(DEBOUNCE * 4);
	assert.equal(imageHandler.calls.length, 2);
	assert.equal(vault.files.get('inbox/a.md').content, '![late.png](https://img.example/late.png)');
});

test('concurrent processing is capped and startup re-scans the watched scope', async () => {
	const { vault, imageHandler, watcher } = await setup({ autoUploadFolders: 'inbox' }, { delayMs: 20 });
	for (let i = 0; i < 6; i++) {
		vault.add(`inbox/n${i}.md`, `![[local-${i}.png]]`);
	}
	vault.add('notes/outside.md', '![[local-x.png]]');
	vault.add('inbox/drawing.excalidraw.md', '![[local-y.png]]');
	watcher.register(); // 启动补扫
	await sleep(150);
	assert.equal(imageHandler.calls.length, 6);
	assert.ok(imageHandler.maxActive <= AutoUploadWatcher.maxConcurrent, `max active was ${imageHandler.maxActive}`);
	assert.equal(vault.files.get('notes/outside.md').content, '![[local-x.png]]');
	assert.equal(vault.files.get('inbox/drawing.excalidraw.md').content, '![[local-y.png]]');
});

test('unload cancels pending work and late results are never written back', async () => {
	const { vault, imageHandler, watcher } = await setup({ autoUploadFolders: 'inbox' }, { delayMs: 40 });
	watcher.register();
	const note = vault.add('inbox/a.md', '![[local-a.png]]');
	vault.emit('modify', note);
	await sleep(DEBOUNCE * 2);
	assert.equal(imageHandler.calls.length, 1);
	watcher.unload();
	await sleep(80);
	assert.equal(vault.files.get('inbox/a.md').content, '![[local-a.png]]');
});

test('manual scan counts the scope, asks for confirmation, and processes even when auto-upload is off', async () => {
	const { vault, imageHandler, watcher } = await setup({ enableAutoUpload: false, autoUploadFolders: '' });
	watcher.register();
	vault.add('a.md', '![[local-a.png]]\n![[local-b.png]]');
	vault.add('b.md', 'no images');
	await watcher.scanAndMigrate();
	assert.ok(globalThis.__openedModal, 'confirmation modal should open');
	assert.equal(imageHandler.calls.length, 0, 'nothing runs before confirmation');

	// 第二个按钮是「确认」；范围内两篇笔记都会被处理（b.md 没有图片，处理后不写回）
	globalThis.__modalButtons[1]();
	await sleep(30);
	assert.deepEqual(imageHandler.calls.map((call) => call.sourcePath).sort(), ['a.md', 'b.md']);
	assert.equal(vault.files.get('b.md').content, 'no images');
	assert.equal(vault.files.get('a.md').content, '![a.png](https://img.example/a.png)\n![b.png](https://img.example/b.png)');
	assert.ok(globalThis.__notices.some((message) => message.startsWith('autoUpload.scanQueued')));
});
