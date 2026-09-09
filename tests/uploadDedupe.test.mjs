import assert from 'node:assert/strict';
import { File as NodeFile } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { build } from 'esbuild';

globalThis.File = NodeFile;

// 最小 obsidian 桩：uploadService 只用到这些导出；requestUrl 通过全局钩子注入以便计数。
const obsidianStub = `
export class Notice { constructor(message) { (globalThis.__notices ??= []).push(String(message)); } }
export class TFile {}
export class TFolder {}
export const getLanguage = () => 'en';
export const normalizePath = (value) => value;
export const moment = () => ({ format: () => '20260101' });
export const requestUrl = (...args) => globalThis.__requestUrl(...args);
`;
const stubObsidian = {
	name: 'stub-obsidian',
	setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: obsidianStub, loader: 'js' }));
	}
};

const buildDir = await mkdtemp(path.join(tmpdir(), 'cf-imgbed-dedupe-test-'));
after(() => rm(buildDir, { recursive: true, force: true }));
async function bundle(entry, name) {
	const outfile = path.join(buildDir, name);
	await build({
		entryPoints: [path.resolve(entry)],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node18',
		outfile,
		plugins: [stubObsidian]
	});
	return import(pathToFileURL(outfile).href);
}
const { UploadService } = await bundle('src/upload/uploadService.ts', 'uploadService.mjs');
const { UploadIndex, buildProcessingPolicy, buildUploadNamespace } = await bundle('src/upload/uploadIndex.ts', 'uploadIndex.mjs');
const { DEFAULT_SETTINGS } = await bundle('src/types/index.ts', 'types.mjs');

function createStorage(initial = {}) {
	const files = new Map(Object.entries(initial));
	return {
		files,
		writes: 0,
		async exists(p) { return files.has(p); },
		async read(p) { return files.get(p); },
		async write(p, data) {
			this.writes++;
			// 模拟真实写盘的异步间隔，暴露并发写入问题
			await new Promise((resolve) => setTimeout(resolve, 2));
			files.set(p, data);
		}
	};
}

function createSettings(overrides = {}) {
	return {
		...DEFAULT_SETTINGS,
		apiUrl: 'http://img.example:7658',
		authCode: 'secret',
		uploadChannel: 'cfr2',
		...overrides
	};
}

function installServer({ delayMs = 0 } = {}) {
	const calls = [];
	globalThis.__notices = [];
	globalThis.__requestUrl = async (request) => {
		calls.push(request);
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		return { status: 200, json: [{ src: `/file/upload-${calls.length}.png` }] };
	};
	return calls;
}

function png(bytes) {
	return new NodeFile([Uint8Array.from(bytes)], 'photo.png', { type: 'image/png' });
}

async function createService(settings, storage = createStorage()) {
	const index = new UploadIndex(storage, 'plugins/cf-imagebed/upload-index.json');
	await index.load();
	const app = { workspace: { getActiveFile: () => null } };
	return { service: new UploadService(app, settings, index), index, storage };
}

test('the same bytes are uploaded once and later uploads reuse the link, even under a different file name', async () => {
	const calls = installServer();
	const { service, index } = await createService(createSettings());

	const first = await service.uploadImageDetailed(png([1, 2, 3]));
	const second = await service.uploadImageDetailed(png([1, 2, 3]));
	const renamed = await service.uploadImageDetailed(new NodeFile([Uint8Array.from([1, 2, 3])], 'other-name.png', { type: 'image/png' }));

	assert.equal(calls.length, 1);
	assert.deepEqual(first, { url: 'http://img.example:7658/file/upload-1.png', src: '/file/upload-1.png', reused: false });
	assert.equal(second.reused, true);
	assert.equal(second.url, first.url);
	assert.equal(renamed.url, first.url);
	assert.equal(index.size, 1);
	assert.ok(globalThis.__notices.some((message) => /uploaded before|已上传过/.test(message)));
});

test('different bytes are uploaded separately and uploadImage() keeps returning a plain URL', async () => {
	const calls = installServer();
	const { service } = await createService(createSettings());

	const a = await service.uploadImage(png([1]));
	const b = await service.uploadImage(png([2]));

	assert.equal(calls.length, 2);
	assert.equal(a, 'http://img.example:7658/file/upload-1.png');
	assert.equal(b, 'http://img.example:7658/file/upload-2.png');
});

test('concurrent uploads of the same image are merged into a single request', async () => {
	const calls = installServer({ delayMs: 15 });
	const { service } = await createService(createSettings());

	const results = await Promise.all([1, 2, 3].map(() => service.uploadImageDetailed(png([9, 9]))));

	assert.equal(calls.length, 1);
	assert.equal(results.filter((result) => !result.reused).length, 1);
	assert.equal(new Set(results.map((result) => result.url)).size, 1);
});

test('the index survives a restart and rebuilds the URL from the current return settings', async () => {
	const calls = installServer();
	const storage = createStorage();
	const first = await createService(createSettings(), storage);
	await first.service.uploadImage(png([5, 5, 5]));
	await first.index.flush();
	assert.equal(storage.writes, 1);

	// "重启"：用同一份存储、不同的返回前缀重新加载
	const second = await createService(createSettings({ customReturnBaseUrl: 'https://cdn.example' }), storage);
	assert.equal(second.index.size, 1);
	const reused = await second.service.uploadImageDetailed(png([5, 5, 5]));

	assert.equal(calls.length, 1);
	assert.equal(reused.reused, true);
	assert.equal(reused.url, 'https://cdn.example/file/upload-1.png');
});

test('changing the target image bed or the processing policy does not reuse old uploads', async () => {
	const calls = installServer();
	const storage = createStorage();
	const base = await createService(createSettings(), storage);
	await base.service.uploadImage(png([7]));

	const otherBed = await createService(createSettings({ apiUrl: 'http://other.example' }), storage);
	await otherBed.service.uploadImage(png([7]));
	const watermarked = await createService(createSettings({ enableWatermark: true, watermarkText: 'x' }), storage);
	await watermarked.service.uploadImage(png([7]));

	assert.equal(calls.length, 3);
	assert.notEqual(buildUploadNamespace(createSettings()), buildUploadNamespace(createSettings({ apiUrl: 'http://other.example' })));
	assert.notEqual(buildProcessingPolicy(createSettings()), buildProcessingPolicy(createSettings({ enableWatermark: true, watermarkText: 'x' })));
});

test('failed uploads are not recorded and dedupe can be disabled or bypassed', async () => {
	globalThis.__notices = [];
	let fail = true;
	const calls = [];
	globalThis.__requestUrl = async (request) => {
		calls.push(request);
		if (fail) {
			return { status: 500, json: null };
		}
		return { status: 200, json: [{ src: '/file/ok.png' }] };
	};
	const { service, index } = await createService(createSettings());

	assert.equal(await service.uploadImage(png([3]), { showErrorNotice: false }), null);
	assert.equal(index.size, 0);

	fail = false;
	assert.equal(await service.uploadImage(png([3])), 'http://img.example:7658/file/ok.png');
	assert.equal(index.size, 1);
	assert.equal(calls.length, 2);

	await service.uploadImage(png([3]), { bypassDedupe: true });
	assert.equal(calls.length, 3);

	const disabled = await createService(createSettings({ enableUploadDedupe: false }));
	await disabled.service.uploadImage(png([3]));
	await disabled.service.uploadImage(png([3]));
	assert.equal(calls.length, 5);
	assert.equal(disabled.index.size, 0);
});

test('index writes are serialized and the final file reflects every entry', async () => {
	const storage = createStorage();
	const index = new UploadIndex(storage, 'idx.json');
	await index.load();

	await Promise.all(
		Array.from({ length: 20 }, (_, i) => index.set(`key-${i}`, { src: `/file/${i}.png`, name: `${i}.png`, size: i, uploadedAt: i }))
	);
	await index.flush();

	const persisted = JSON.parse(storage.files.get('idx.json'));
	assert.equal(persisted.version, 2);
	assert.equal(Object.keys(persisted.entries).length, 20);
	assert.ok(storage.writes < 20, `expected coalesced writes, got ${storage.writes}`);

	assert.equal(await index.deleteBySrc('/file/3.png'), 1);
	await index.flush();
	assert.equal(Object.keys(JSON.parse(storage.files.get('idx.json')).entries).length, 19);
	assert.equal(index.findBySrc('/file/4.png')?.key, 'key-4');
});

test('a corrupt or foreign index file is ignored instead of crashing', async () => {
	const storage = createStorage({ 'idx.json': '{not json' });
	const index = new UploadIndex(storage, 'idx.json');
	await index.load();
	assert.equal(index.size, 0);

	const foreign = new UploadIndex(createStorage({ 'idx.json': JSON.stringify({ version: 99, entries: { a: { src: '/x' } } }) }), 'idx.json');
	await foreign.load();
	assert.equal(foreign.size, 0);
});

test('when the shared first request fails, the waiters coalesce onto one retry instead of each re-uploading', async () => {
	globalThis.__notices = [];
	let calls = 0;
	globalThis.__requestUrl = async () => {
		calls++;
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (calls === 1) {
			return { status: 500, json: null };
		}
		return { status: 200, json: [{ src: '/file/retry.png' }] };
	};
	const { service } = await createService(createSettings());

	const results = await Promise.all([1, 2, 3].map(() => service.uploadImageDetailed(png([4, 2]), { showErrorNotice: false })));

	assert.equal(calls, 2, 'one failed request + exactly one shared retry');
	// 发起失败请求的调用如实返回 null；两个等待者合并到同一次重试并复用其结果
	assert.equal(results.filter((result) => result === null).length, 1);
	assert.deepEqual(
		results.filter(Boolean).map((result) => result.url),
		['http://img.example:7658/file/retry.png', 'http://img.example:7658/file/retry.png']
	);
});

test('a cached relative src is always prefixed, even after switching returnFormat to full', async () => {
	installServer();
	const storage = createStorage();
	const first = await createService(createSettings({ returnFormat: 'default' }), storage);
	await first.service.uploadImage(png([6]));
	await first.index.flush();

	const second = await createService(createSettings({ returnFormat: 'full' }), storage);
	const reused = await second.service.uploadImageDetailed(png([6]));
	assert.equal(reused.reused, true);
	assert.equal(reused.url, 'http://img.example:7658/file/upload-1.png');
	assert.equal(second.service.buildReturnUrl('https://cdn.example/abs.png'), 'https://cdn.example/abs.png');
	assert.equal(second.service.buildReturnUrl('file/no-slash.png'), 'http://img.example:7658/file/no-slash.png');
});

test('namespace includes the API path, so two deployments on one host do not share uploads', () => {
	assert.notEqual(
		buildUploadNamespace(createSettings({ apiUrl: 'https://host.example/imgbed-a' })),
		buildUploadNamespace(createSettings({ apiUrl: 'https://host.example/imgbed-b' }))
	);
	assert.equal(
		buildUploadNamespace(createSettings({ apiUrl: 'https://host.example/imgbed-a/' })),
		buildUploadNamespace(createSettings({ apiUrl: 'https://HOST.example/imgbed-a' }))
	);
});

test('changing the target image bed while an upload is in flight does not record the result under the old key', async () => {
	const settings = createSettings();
	let calls = 0;
	globalThis.__requestUrl = async () => {
		calls++;
		settings.apiUrl = 'http://other.example'; // 上传途中切换图床
		return { status: 200, json: [{ src: '/file/moved.png' }] };
	};
	const { service, index } = await createService(settings);
	const outcome = await service.uploadImageDetailed(png([8, 8]));
	assert.equal(outcome.src, '/file/moved.png');
	// 快照：请求、返回链接、索引键都来自上传开始时的设置
	assert.equal(outcome.url, 'http://img.example:7658/file/moved.png', 'url must use the image bed the request was sent to');
	assert.equal(index.size, 1);
	assert.equal(index.findBySrc('/file/moved.png')?.key.includes('img.example:7658'), true);
	assert.equal(calls, 1);

	// 快照之后的上传才使用新图床
	const next = await service.uploadImageDetailed(png([8, 9]));
	assert.equal(next.url, 'http://other.example/file/moved.png');
});

test('namespace keeps path case but folds host case', () => {
	assert.notEqual(
		buildUploadNamespace(createSettings({ apiUrl: 'https://host.example/A' })),
		buildUploadNamespace(createSettings({ apiUrl: 'https://host.example/a' }))
	);
	assert.equal(
		buildUploadNamespace(createSettings({ apiUrl: 'https://HOST.example/A/' })),
		buildUploadNamespace(createSettings({ apiUrl: 'https://host.example/A' }))
	);
});

test('a legacy v1 index is kept only when the current API URL has no path, and is rewritten as v2', async () => {
	const v1 = JSON.stringify({ version: 1, entries: { 'h|https://host.example|cfr2||wm:off;cmp:off;srv:off': { src: '/file/old.png', name: 'o', size: 1, uploadedAt: 1 } } });

	const compatible = createStorage({ 'idx.json': v1 });
	const keep = new UploadIndex(compatible, 'idx.json');
	await keep.load({ acceptLegacyV1: true });
	await keep.flush();
	assert.equal(keep.size, 1);
	assert.equal(JSON.parse(compatible.files.get('idx.json')).version, 2);

	const incompatible = createStorage({ 'idx.json': v1 });
	const drop = new UploadIndex(incompatible, 'idx.json');
	await drop.load({ acceptLegacyV1: false });
	await drop.flush();
	assert.equal(drop.size, 0);
	assert.equal(JSON.parse(incompatible.files.get('idx.json')).version, 2);
	assert.deepEqual(JSON.parse(incompatible.files.get('idx.json')).entries, {});
});
