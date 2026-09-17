import assert from 'node:assert/strict';
import { File as NodeFile } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { build } from 'esbuild';

globalThis.File = NodeFile;

const obsidianStub = `
export class Notice { constructor() {} }
export class TFile { constructor(p, size) { this.path = p; this.stat = { size }; } }
export class TFolder { constructor(p) { this.path = p; } }
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

const buildDir = await mkdtemp(path.join(tmpdir(), 'cf-imgbed-backup-test-'));
after(() => rm(buildDir, { recursive: true, force: true }));
const outfile = path.join(buildDir, 'bundle.mjs');
await build({
	stdin: {
		contents: "export { UploadService } from './src/upload/uploadService.ts'; export { DEFAULT_SETTINGS } from './src/types/index.ts'; export { TFile, TFolder } from 'obsidian';",
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
const { UploadService, DEFAULT_SETTINGS, TFile, TFolder } = await import(pathToFileURL(outfile).href);

/** 内存 vault：记录每个路径的字节，任何对已有文件的改写都会被 modified 记下来。 */
function createVault(initialFiles = {}) {
	const entries = new Map([['backup', new TFolder('backup')]]);
	const contents = new Map();
	for (const [filePath, bytes] of Object.entries(initialFiles)) {
		entries.set(filePath, new TFile(filePath, bytes.length));
		contents.set(filePath, Uint8Array.from(bytes));
	}
	return {
		contents,
		modified: [],
		getAbstractFileByPath: (p) => entries.get(p) ?? null,
		async createFolder(p) { entries.set(p, new TFolder(p)); },
		async createBinary(p, data) {
			if (entries.has(p)) {
				throw new Error(`File already exists: ${p}`);
			}
			entries.set(p, new TFile(p, data.byteLength));
			contents.set(p, new Uint8Array(data));
		},
		async modifyBinary(file) { this.modified.push(file.path); },
		async readBinary(file) {
			const bytes = contents.get(file.path);
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		}
	};
}

function createService(vault) {
	globalThis.__requestUrl = async () => ({ status: 200, json: [{ src: '/file/x.png' }] });
	const settings = {
		...DEFAULT_SETTINGS,
		apiUrl: 'http://img.example:7658',
		authCode: 'secret',
		enableLocalBackup: true,
		backupPath: 'backup'
	};
	return new UploadService({ vault, workspace: { getActiveFile: () => null } }, settings);
}

const image = (bytes, name = 'image.png') => new NodeFile([Uint8Array.from(bytes)], name, { type: 'image/png' });

test('different images sharing a file name are all kept in the backup folder', async () => {
	const vault = createVault();
	const service = createService(vault);

	await service.uploadImageDetailed(image([1, 1, 1]));
	await service.uploadImageDetailed(image([2, 2, 2]));
	await service.uploadImageDetailed(image([3, 3, 3, 3]));

	assert.deepEqual(Array.from(vault.contents.keys()), ['backup/image.png', 'backup/image-1.png', 'backup/image-2.png']);
	assert.deepEqual(Array.from(vault.contents.get('backup/image.png')), [1, 1, 1]);
	assert.deepEqual(Array.from(vault.contents.get('backup/image-1.png')), [2, 2, 2]);
	assert.deepEqual(vault.modified, []);
});

test('backing up the same bytes twice does not pile up copies', async () => {
	const vault = createVault();
	const service = createService(vault);

	await service.uploadImageDetailed(image([7, 7, 7]));
	await service.uploadImageDetailed(image([7, 7, 7]));

	assert.deepEqual(Array.from(vault.contents.keys()), ['backup/image.png']);
});

test('an existing file in the backup folder (e.g. the original attachment) is never overwritten', async () => {
	const vault = createVault({ 'backup/image.png': [9, 9, 9, 9, 9] });
	const service = createService(vault);

	await service.uploadImageDetailed(image([1, 2, 3]));

	assert.deepEqual(Array.from(vault.contents.get('backup/image.png')), [9, 9, 9, 9, 9]);
	assert.deepEqual(Array.from(vault.contents.get('backup/image-1.png')), [1, 2, 3]);
	assert.deepEqual(vault.modified, []);
});

test('concurrent uploads of different images with the same name are all backed up', async () => {
	const vault = createVault();
	const createBinary = vault.createBinary.bind(vault);
	// 真实写盘有延迟：并发任务会在对方创建完成之前选中同一个「尚不存在」的路径
	vault.createBinary = async (p, data) => { await new Promise((resolve) => setTimeout(resolve, 5)); return createBinary(p, data); };
	const service = createService(vault);

	await Promise.all([[1, 1], [2, 2], [3, 3]].map((bytes) => service.uploadImageDetailed(image(bytes))));

	assert.deepEqual(Array.from(vault.contents.keys()).sort(), ['backup/image-1.png', 'backup/image-2.png', 'backup/image.png']);
});
