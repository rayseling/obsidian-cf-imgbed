import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { build } from 'esbuild';

const obsidianStub = `
export class TFile { constructor(p, mtime = 1, size = 0) { this.path = p; this.name = p.split('/').pop(); this.extension = this.name.split('.').pop(); this.stat = { mtime, size }; } }
export class MarkdownView { constructor(content, file = null) { this.editor = { getValue: () => content }; this.file = file; } }
export class Notice { constructor(message) { (globalThis.__notices ??= []).push(String(message)); } }
export const requestUrl = () => { throw new Error('requestUrl must be injected'); };
`;
const stubObsidian = {
	name: 'stub-obsidian',
	setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: obsidianStub, loader: 'js' }));
	}
};

const buildDir = await mkdtemp(path.join(tmpdir(), 'cf-imgbed-cleaner-test-'));
after(() => rm(buildDir, { recursive: true, force: true }));
const outfile = path.join(buildDir, 'cleaner.mjs');
await build({
	stdin: {
		contents: [
			"export { LocalImageCleaner } from './src/upload/localImageCleaner.ts';",
			"export { UploadIndex, buildUploadIndexKey, buildUploadNamespace, buildProcessingPolicy } from './src/upload/uploadIndex.ts';",
			"export { sha256Hex } from './src/utils/contentHash.ts';",
			"export { DEFAULT_SETTINGS } from './src/types/index.ts';",
			"export { TFile, MarkdownView } from 'obsidian';"
		].join('\n'),
		resolveDir: process.cwd(),
		loader: 'js'
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	outfile,
	plugins: [stubObsidian]
});
const {
	LocalImageCleaner, UploadIndex, buildUploadIndexKey, buildUploadNamespace, buildProcessingPolicy,
	sha256Hex, DEFAULT_SETTINGS, TFile, MarkdownView
} = await import(pathToFileURL(outfile).href);

LocalImageCleaner.resolveTimeoutMs = 30;

function createSettings(overrides = {}) {
	return {
		...DEFAULT_SETTINGS,
		apiUrl: 'http://img.example:7658',
		authCode: 'x',
		uploadChannel: 'cfr2',
		deleteLocalAfterUpload: true,
		enableUploadDedupe: true,
		notificationDuration: 1,
		...overrides
	};
}

function createApp() {
	const entries = new Map(); // path -> { file, bytes?, text? }
	const resolveHandlers = new Set();
	const app = {
		trashed: [],
		leaves: [],
		vault: {
			addBinary(p, bytes) {
				const existing = entries.get(p);
				const file = existing?.file ?? new TFile(p, 1, bytes.length);
				if (existing) { file.stat.mtime++; file.stat.size = bytes.length; }
				entries.set(p, { file, bytes: Uint8Array.from(bytes) });
				return file;
			},
			addText(p, text, mtime = 1) { const file = new TFile(p, mtime); entries.set(p, { file, text }); return file; },
			setText(p, text) { const entry = entries.get(p); entry.text = text; entry.file.stat.mtime++; },
			getFiles: () => Array.from(entries.values()).map((entry) => entry.file),
			getAbstractFileByPath: (p) => entries.get(p)?.file ?? null,
			async readBinary(file) { return entries.get(file.path).bytes.buffer.slice(0); },
			async cachedRead(file) {
				app.onCachedRead?.(file);
				return entries.get(file.path).text ?? '';
			}
		},
		metadataCache: {
			resolvedLinks: {},
			on(name, callback) { assert.equal(name, 'resolve'); resolveHandlers.add(callback); return callback; },
			offref(ref) { resolveHandlers.delete(ref); },
			emitResolve(file) { for (const handler of Array.from(resolveHandlers)) handler(file); },
			get listenerCount() { return resolveHandlers.size; }
		},
		workspace: {
			iterateAllLeaves(callback) { for (const leaf of app.leaves) callback(leaf); }
		},
		fileManager: {
			async trashFile(file) { app.trashed.push(file.path); entries.delete(file.path); }
		}
	};
	return app;
}

async function indexImage(index, settings, bytes, src) {
	const hash = await sha256Hex(Uint8Array.from(bytes));
	await index.set(buildUploadIndexKey(hash, buildUploadNamespace(settings), buildProcessingPolicy(settings)), {
		src, name: 'x.png', size: bytes.length, uploadedAt: 1
	});
}

/** 默认 HEAD/GET 都返回 200 image/png；perMethod 可为某个方法单独指定 status / contentType / body。 */
function createFetcher({ status = 200, contentType = 'image/png', onCall, perMethod = {} } = {}) {
	const calls = [];
	const fetcher = async (request) => {
		calls.push(request);
		onCall?.(request);
		const spec = { status, contentType, body: undefined, ...(perMethod[request.method] ?? {}) };
		return {
			status: spec.status,
			headers: spec.contentType ? { 'content-type': spec.contentType } : {},
			arrayBuffer: spec.body ? Uint8Array.from(spec.body).buffer : undefined
		};
	};
	fetcher.calls = calls;
	return fetcher;
}

/** 常见起点：一张已上传并索引的图片，一篇已改写链接的笔记。 */
async function setup({ settings = createSettings(), fetcher = createFetcher() } = {}) {
	const app = createApp();
	const index = new UploadIndex({ async exists() { return false; }, async read() { return ''; }, async write() {} }, 'idx.json');
	await index.load();
	const bytes = [1, 2, 3, 4];
	const image = app.vault.addBinary('attachments/pic.png', bytes);
	const note = app.vault.addText('notes/a.md', '![pic](http://img.example:7658/file/pic.png)');
	await indexImage(index, settings, bytes, '/file/pic.png');
	const i18n = { t: (key, params) => `${key}${params ? ' ' + JSON.stringify(params) : ''}` };
	const cleaner = new LocalImageCleaner(app, index, () => settings, (src) => `http://img.example:7658${src}`, i18n, fetcher);
	const uploaded = [{ file: image, src: '/file/pic.png', url: 'http://img.example:7658/file/pic.png' }];
	globalThis.__notices = [];
	return { app, index, cleaner, image, note, uploaded, fetcher, settings };
}

async function runAfterWriteBack(ctx, { resolve = true } = {}) {
	const waiter = ctx.cleaner.expectResolve(ctx.note);
	const pending = ctx.cleaner.cleanupAfterWriteBack(ctx.uploaded, ctx.note, waiter);
	if (resolve) {
		ctx.app.metadataCache.emitResolve(ctx.note);
	}
	return pending;
}

test('happy path: uploaded, rewritten, unreferenced, remote verified → moved to trash', async () => {
	const ctx = await setup();
	const report = await runAfterWriteBack(ctx);
	assert.deepEqual(report, { deleted: ['attachments/pic.png'], kept: [] });
	assert.deepEqual(ctx.app.trashed, ['attachments/pic.png']);
	assert.equal(ctx.fetcher.calls[0].method, 'HEAD');
	assert.equal(ctx.app.metadataCache.listenerCount, 0, 'resolve listener must be disposed');
	assert.ok(globalThis.__notices.some((message) => message.startsWith('cleanup.summary')));
});

test('the resolve listener is registered before write-back and a timeout keeps the image', async () => {
	const ctx = await setup();
	const report = await runAfterWriteBack(ctx, { resolve: false });
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'resolve-timeout' }]);
	assert.deepEqual(ctx.app.trashed, []);
	assert.equal(ctx.fetcher.calls.length, 0, 'no network call before local checks pass');
});

test('a reference from any other note (resolvedLinks) keeps the image', async () => {
	const ctx = await setup();
	ctx.app.metadataCache.resolvedLinks = { 'notes/b.md': { 'attachments/pic.png': 1 } };
	const report = await runAfterWriteBack(ctx);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'referenced' }]);
	assert.deepEqual(ctx.app.trashed, []);
});

test('Canvas references and unparsable Canvas files both block deletion', async () => {
	const ctx = await setup();
	ctx.app.vault.addText('boards/x.canvas', JSON.stringify({ nodes: [{ type: 'file', file: 'attachments/pic.png' }] }));
	let report = await runAfterWriteBack(ctx);
	assert.equal(report.kept[0].reason, 'referenced');

	ctx.app.vault.setText('boards/x.canvas', '{ not json');
	report = await runAfterWriteBack(ctx);
	assert.equal(report.kept[0].reason, 'referenced');
	assert.deepEqual(ctx.app.trashed, []);
});

test('references the metadata cache cannot see (HTML <img>, plain text) block deletion via full-text search', async () => {
	const ctx = await setup();
	ctx.app.vault.addText('notes/html.md', '<img src="attachments/PIC.png">');
	const report = await runAfterWriteBack(ctx);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'referenced' }]);
});

test('an open editor that still mentions the image blocks deletion', async () => {
	const ctx = await setup();
	ctx.app.leaves = [{ view: new MarkdownView('draft text ![[pic.png]]') }];
	const report = await runAfterWriteBack(ctx);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'unsaved-edit' }]);
});

test('bytes that no longer match the uploaded version are never deleted', async () => {
	const ctx = await setup();
	// 图片在上传后被覆盖成另一张（同名）
	ctx.app.vault.addBinary('attachments/pic.png', [9, 9, 9]);
	let report = await runAfterWriteBack(ctx);
	assert.equal(report.kept[0].reason, 'not-in-index');

	// 字节命中索引但指向另一个 src（另一张图的记录）
	await indexImage(ctx.index, ctx.settings, [9, 9, 9], '/file/other.png');
	report = await runAfterWriteBack(ctx);
	assert.equal(report.kept[0].reason, 'hash-mismatch');
	assert.deepEqual(ctx.app.trashed, []);
});

test('remote verification failures keep the image (404, non-image response, exception)', async () => {
	for (const fetcher of [
		createFetcher({ status: 404 }),
		createFetcher({ contentType: 'text/html' }),
		Object.assign(async () => { throw new Error('offline'); }, { calls: [] })
	]) {
		const ctx = await setup({ fetcher });
		const report = await runAfterWriteBack(ctx);
		assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'remote-unverified' }]);
		assert.deepEqual(ctx.app.trashed, []);
	}
});

test('a reference that appears during remote verification is caught by the final re-check', async () => {
	let ctxRef = null;
	const fetcher = createFetcher({
		onCall: () => {
			ctxRef.app.metadataCache.resolvedLinks = { 'notes/late.md': { 'attachments/pic.png': 1 } };
		}
	});
	const ctx = await setup({ fetcher });
	ctxRef = ctx;
	const report = await runAfterWriteBack(ctx);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'referenced' }]);
	assert.deepEqual(ctx.app.trashed, []);
});

test('feature off or dedupe index off → nothing is deleted and no network call is made', async () => {
	const off = await setup({ settings: createSettings({ deleteLocalAfterUpload: false }) });
	assert.equal(off.cleaner.isEnabled(), false);
	let report = await runAfterWriteBack(off);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'disabled' }]);
	assert.equal(off.fetcher.calls.length, 0);

	const noDedupe = await setup({ settings: createSettings({ enableUploadDedupe: false }) });
	report = await runAfterWriteBack(noDedupe);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'dedupe-disabled' }]);
	assert.deepEqual(noDedupe.app.trashed, []);
});

test('orphan scan lists only indexed, unreferenced images; cleanup re-checks each one before trashing', async () => {
	const ctx = await setup();
	ctx.app.vault.addBinary('attachments/unknown.png', [7, 7]); // 从未上传过
	const referenced = ctx.app.vault.addBinary('attachments/used.png', [5, 5]);
	await indexImage(ctx.index, ctx.settings, [5, 5], '/file/used.png');
	ctx.app.vault.addText('notes/c.md', '![[used.png]]');

	const orphans = await ctx.cleaner.findOrphans();
	assert.deepEqual(orphans.map((item) => item.file.path), ['attachments/pic.png']);
	assert.equal(orphans[0].url, 'http://img.example:7658/file/pic.png');

	// 预览确认后、删除前有人又引用了它 → 复核拦下
	ctx.app.vault.addText('notes/d.md', 'see attachments/pic.png');
	let report = await ctx.cleaner.cleanupOrphans(orphans);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'referenced' }]);

	ctx.app.vault.setText('notes/d.md', 'nothing here');
	report = await ctx.cleaner.cleanupOrphans(orphans);
	assert.deepEqual(report, { deleted: ['attachments/pic.png'], kept: [] });
	assert.equal(ctx.app.vault.getAbstractFileByPath('attachments/used.png'), referenced);
	assert.ok(ctx.app.vault.getAbstractFileByPath('attachments/unknown.png'));
});

test('percent-encoded and entity-encoded references to a file name with spaces block deletion', async () => {
	for (const html of ['<img src="attachments/pic%201.png">', '<img src="attachments/pic&#32;1.png">', '![x](attachments/pic%201.png)']) {
		const ctx = await setup();
		ctx.app.vault.addBinary('attachments/pic 1.png', [1, 2, 3, 4]); // 与 pic.png 同字节
		ctx.app.vault.addText('notes/html.md', html);
		const image = ctx.app.vault.getAbstractFileByPath('attachments/pic 1.png');
		const report = await ctx.cleaner.cleanupOrphans([{ file: image, src: '/file/pic.png', url: 'http://img.example:7658/file/pic.png' }]);
		assert.deepEqual(report.kept, [{ path: 'attachments/pic 1.png', reason: 'referenced' }], html);
		assert.deepEqual(ctx.app.trashed, []);
	}
});

test('the file name inside the alt of the rewritten remote image does not count as a reference', async () => {
	const ctx = await setup();
	// 真实改写结果：![[pic.png]] → ![pic.png](https://…/pic.png)，另有一处 <img src="http…/pic.png">
	ctx.app.vault.setText('notes/a.md', '![pic.png](http://img.example:7658/file/pic.png)\n<img src="http://img.example:7658/file/pic.png" alt="pic.png">');
	const report = await runAfterWriteBack(ctx);
	assert.deepEqual(report, { deleted: ['attachments/pic.png'], kept: [] });
});

test('open non-Markdown views are protected: readable view data is searched, unreadable note/canvas views block', async () => {
	const canvasView = await setup();
	canvasView.app.leaves = [{ view: { file: new TFile('boards/open.canvas'), getViewData: () => JSON.stringify({ nodes: [{ type: 'file', file: 'attachments/pic.png' }] }) } }];
	let report = await runAfterWriteBack(canvasView);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'unsaved-edit' }]);

	const opaque = await setup();
	opaque.app.leaves = [{ view: { file: new TFile('boards/opaque.canvas') } }];
	report = await runAfterWriteBack(opaque);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'unsaved-edit' }]);

	const viewingImage = await setup();
	viewingImage.app.leaves = [{ view: { file: viewingImage.image } }];
	report = await runAfterWriteBack(viewingImage);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'unsaved-edit' }]);

	const harmless = await setup();
	harmless.app.leaves = [
		{ view: { file: new TFile('docs/manual.pdf') } },
		{ view: { file: new TFile('boards/other.canvas'), getViewData: () => JSON.stringify({ nodes: [] }) } },
		{ view: new MarkdownView('![pic.png](http://img.example:7658/file/pic.png)') }
	];
	report = await runAfterWriteBack(harmless);
	assert.deepEqual(report.deleted, ['attachments/pic.png']);
});

test('remote verification requires proof of an image: HEAD without content-type falls through to GET', async () => {
	// HEAD 200 无 Content-Type，GET 返回 HTML → 保留
	const html = await setup({ fetcher: createFetcher({ perMethod: { HEAD: { contentType: '' }, GET: { contentType: 'text/html', body: [60, 104] } } }) });
	let report = await runAfterWriteBack(html);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'remote-unverified' }]);
	assert.deepEqual(html.fetcher.calls.map((call) => call.method), ['HEAD', 'GET']);

	// HEAD 200 无 Content-Type，GET 无 Content-Type 但响应体是 PNG 魔数 → 通过
	const png = await setup({ fetcher: createFetcher({ perMethod: { HEAD: { contentType: '' }, GET: { contentType: '', body: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a] } } }) });
	report = await runAfterWriteBack(png);
	assert.deepEqual(report.deleted, ['attachments/pic.png']);

	// HEAD 200 无 Content-Type，GET 无 Content-Type 且响应体为空 → 保留
	const empty = await setup({ fetcher: createFetcher({ perMethod: { HEAD: { contentType: '' }, GET: { contentType: '' } } }) });
	report = await runAfterWriteBack(empty);
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'remote-unverified' }]);
});

test('an image overwritten during the final reference scan is not deleted', async () => {
	let ctxRef = null;
	const fetcher = createFetcher({
		// 远端验证期间另一篇笔记被修改 → 第二轮全库扫描必须重读它（绕过 mtime 缓存）
		onCall: () => ctxRef.app.vault.setText('notes/other.md', 'edited')
	});
	const ctx = await setup({ fetcher });
	ctxRef = ctx;
	ctx.app.vault.addText('notes/other.md', 'nothing');
	let overwritten = false;
	ctx.app.onCachedRead = (file) => {
		// 第二轮扫描重读 other.md 的那一刻，同路径图片被换成了未上传的新内容
		if (file.path === 'notes/other.md' && ctx.fetcher.calls.length > 0 && !overwritten) {
			overwritten = true;
			ctx.app.vault.addBinary('attachments/pic.png', [9, 9, 9, 9, 9]);
		}
	};
	const report = await runAfterWriteBack(ctx);
	assert.equal(overwritten, true, 'the overwrite must happen during the final scan');
	assert.equal(report.deleted.length, 0);
	assert.ok(['not-in-index', 'changed'].includes(report.kept[0].reason), report.kept[0].reason);
	assert.ok(ctx.app.vault.getAbstractFileByPath('attachments/pic.png'));
});
