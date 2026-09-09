import assert from 'node:assert/strict';
import { File as NodeFile } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { build } from 'esbuild';

globalThis.File = NodeFile;

/**
 * 组合测试：真实 ImageHandler.uploadImagesInText → 模拟写回 → 真实 LocalImageCleaner。
 * 目的：验证真实改写结果（![[pic.png]] → ![pic.png](http…/pic.png)）之后图片能被清理，
 * 而不是依赖测试里手写的笔记内容。
 */
const obsidianStub = `
export class TFile { constructor(p, mtime = 1, size = 0) { this.path = p; this.name = p.split('/').pop(); this.extension = this.name.split('.').pop(); this.stat = { mtime, size }; } }
export class MarkdownView { constructor(content) { this.editor = { getValue: () => content }; } }
export class Notice { constructor(message) { (globalThis.__notices ??= []).push(String(message)); } }
export const Platform = { isMobile: false };
export const requestUrl = () => { throw new Error('requestUrl must be injected'); };
`;
const stubObsidian = {
	name: 'stub-obsidian',
	setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: obsidianStub, loader: 'js' }));
	}
};

const buildDir = await mkdtemp(path.join(tmpdir(), 'cf-imgbed-combo-test-'));
after(() => rm(buildDir, { recursive: true, force: true }));
const outfile = path.join(buildDir, 'combo.mjs');
await build({
	stdin: {
		contents: [
			"export { ImageHandler } from './src/upload/imageHandler.ts';",
			"export { LocalImageCleaner } from './src/upload/localImageCleaner.ts';",
			"export { UploadIndex, buildUploadIndexKey, buildUploadNamespace, buildProcessingPolicy } from './src/upload/uploadIndex.ts';",
			"export { sha256Hex } from './src/utils/contentHash.ts';",
			"export { DEFAULT_SETTINGS } from './src/types/index.ts';",
			"export { TFile } from 'obsidian';"
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
	ImageHandler, LocalImageCleaner, UploadIndex, buildUploadIndexKey, buildUploadNamespace, buildProcessingPolicy,
	sha256Hex, DEFAULT_SETTINGS, TFile
} = await import(pathToFileURL(outfile).href);

LocalImageCleaner.resolveTimeoutMs = 30;
const BASE = 'http://img.example:7658';

function createSettings(overrides = {}) {
	return {
		...DEFAULT_SETTINGS,
		apiUrl: BASE,
		authCode: 'x',
		uploadChannel: 'cfr2',
		deleteLocalAfterUpload: true,
		enableUploadDedupe: true,
		notificationDuration: 1,
		...overrides
	};
}

function createApp() {
	const entries = new Map();
	const resolveHandlers = new Set();
	const app = {
		trashed: [],
		leaves: [],
		vault: {
			addBinary(p, bytes) { const file = new TFile(p, 1, bytes.length); entries.set(p, { file, bytes: Uint8Array.from(bytes) }); return file; },
			addText(p, text) { const file = new TFile(p, 1, text.length); entries.set(p, { file, text }); return file; },
			setText(p, text) { const entry = entries.get(p); entry.text = text; entry.file.stat.mtime++; },
			getFiles: () => Array.from(entries.values()).map((entry) => entry.file),
			getAbstractFileByPath: (p) => entries.get(p)?.file ?? null,
			async readBinary(file) { return entries.get(file.path).bytes.buffer.slice(0); },
			async cachedRead(file) { return entries.get(file.path).text ?? ''; },
			adapter: { getBasePath: () => 'C:/vault' }
		},
		metadataCache: {
			resolvedLinks: {},
			getFirstLinkpathDest(linkPath) { return entries.get(linkPath)?.file ?? entries.get(`attachments/${linkPath}`)?.file ?? null; },
			on(name, callback) { resolveHandlers.add(callback); return callback; },
			offref(ref) { resolveHandlers.delete(ref); },
			emitResolve(file) { for (const handler of Array.from(resolveHandlers)) handler(file); }
		},
		workspace: {
			getActiveFile: () => null,
			getActiveViewOfType: () => null,
			iterateAllLeaves(callback) { for (const leaf of app.leaves) callback(leaf); }
		},
		fileManager: {
			async trashFile(file) { app.trashed.push(file.path); entries.delete(file.path); }
		}
	};
	return app;
}

async function createStack(settings = createSettings()) {
	const app = createApp();
	const index = new UploadIndex({ async exists() { return false; }, async read() { return ''; }, async write() {} }, 'idx.json');
	await index.load();
	// 真实索引写入由 UploadService 完成；这里用一个记录到同一索引的假上传服务替代网络层
	const uploadService = {
		async uploadImageDetailed(file) {
			const hash = await sha256Hex(await file.arrayBuffer());
			const src = `/file/${file.name}`;
			await index.set(buildUploadIndexKey(hash, buildUploadNamespace(settings), buildProcessingPolicy(settings)), { src, name: file.name, size: file.size, uploadedAt: 1 });
			return { url: `${BASE}${src}`, src, reused: false };
		},
		async uploadImage(file) { return (await this.uploadImageDetailed(file)).url; }
	};
	const i18n = { t: (key, params) => `${key}${params ? ' ' + JSON.stringify(params) : ''}` };
	const fetcher = async () => ({ status: 200, headers: { 'content-type': 'image/png' } });
	const cleaner = new LocalImageCleaner(app, index, () => settings, (src) => `${BASE}${src}`, i18n, fetcher);
	const handler = new ImageHandler(app, uploadService, () => settings, i18n, cleaner);
	globalThis.__notices = [];
	return { app, index, cleaner, handler };
}

test('real rewrite of ![[pic.png]] followed by cleanup trashes the local image', async () => {
	const { app, cleaner, handler } = await createStack();
	app.vault.addBinary('attachments/pic.png', [1, 2, 3, 4]);
	const note = app.vault.addText('notes/a.md', '# t\n![[pic.png]]\n![[pic.png|200]]');

	const result = await handler.uploadImagesInText(await app.vault.cachedRead(note), note, note.path, { allowAbsolutePaths: false });
	assert.equal(result.success, 2);
	assert.equal(result.content, `# t\n![pic.png](${BASE}/file/pic.png)\n![200](${BASE}/file/pic.png)`);
	assert.deepEqual(result.uploadedVaultFiles.map((item) => [item.file.path, item.src]), [['attachments/pic.png', '/file/pic.png']]);

	// 模拟监听器：写回前注册 resolve 监听，写回，等待解析
	const waiter = cleaner.expectResolve(note);
	app.vault.setText(note.path, result.content);
	const pending = cleaner.cleanupAfterWriteBack(result.uploadedVaultFiles, note, waiter);
	app.metadataCache.emitResolve(note);
	const report = await pending;

	assert.deepEqual(report, { deleted: ['attachments/pic.png'], kept: [] });
	assert.deepEqual(app.trashed, ['attachments/pic.png']);
});

test('after a real rewrite the image is listed as an orphan; a second note still using it prevents both paths', async () => {
	const { app, cleaner, handler } = await createStack();
	app.vault.addBinary('attachments/pic.png', [1, 2, 3, 4]);
	const note = app.vault.addText('notes/a.md', '![[pic.png]]');
	const other = app.vault.addText('notes/b.md', 'still uses ![[pic.png]]');
	app.metadataCache.resolvedLinks = { 'notes/b.md': { 'attachments/pic.png': 1 } };

	const result = await handler.uploadImagesInText('![[pic.png]]', note, note.path, { allowAbsolutePaths: false });
	const waiter = cleaner.expectResolve(note);
	app.vault.setText(note.path, result.content);
	const pending = cleaner.cleanupAfterWriteBack(result.uploadedVaultFiles, note, waiter);
	app.metadataCache.emitResolve(note);
	let report = await pending;
	assert.deepEqual(report.kept, [{ path: 'attachments/pic.png', reason: 'referenced' }]);
	assert.deepEqual(await cleaner.findOrphans(), []);

	// b.md 也迁移后（真实改写），图片才成为孤立文件
	const second = await handler.uploadImagesInText(await app.vault.cachedRead(other), other, other.path, { allowAbsolutePaths: false });
	app.vault.setText(other.path, second.content);
	app.metadataCache.resolvedLinks = {};
	const orphans = await cleaner.findOrphans();
	assert.deepEqual(orphans.map((item) => item.file.path), ['attachments/pic.png']);
	report = await cleaner.cleanupOrphans(orphans);
	assert.deepEqual(report.deleted, ['attachments/pic.png']);
});
