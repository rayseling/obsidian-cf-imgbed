import assert from 'node:assert/strict';
import { File as NodeFile } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { build } from 'esbuild';

globalThis.File = NodeFile;

// requestUrl 通过全局钩子注入，模拟远程响应
const obsidianStub = `
export class TFile { constructor(p) { this.path = p; this.name = p.split('/').pop(); this.extension = this.name.split('.').pop(); } }
export class Notice { constructor() {} }
export class MarkdownView {}
export const Platform = { isMobile: false };
export const requestUrl = (...args) => globalThis.__requestUrl(...args);
export const htmlToMarkdown = (html) => html;
`;
const stubObsidian = {
	name: 'stub-obsidian',
	setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: obsidianStub, loader: 'js' }));
	}
};

const buildDir = await mkdtemp(path.join(tmpdir(), 'cf-imgbed-sniff-test-'));
after(() => rm(buildDir, { recursive: true, force: true }));
const outfile = path.join(buildDir, 'bundle.mjs');
await build({
	stdin: {
		contents: "export { ImageHandler } from './src/upload/imageHandler.ts'; export { sniffImageMimeType } from './src/utils/imageSniffer.ts'; export { classifyRemoteHost } from './src/utils/networkGuard.ts'; export { TFile } from 'obsidian';",
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
const { ImageHandler, sniffImageMimeType, classifyRemoteHost, TFile } = await import(pathToFileURL(outfile).href);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const bytes = (text) => new TextEncoder().encode(text);
const buffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

test('sniffer recognises real image formats by their header', () => {
	assert.equal(sniffImageMimeType(buffer(PNG)), 'image/png');
	assert.equal(sniffImageMimeType(buffer(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))), 'image/jpeg');
	assert.equal(sniffImageMimeType(buffer(bytes('GIF89a......'))), 'image/gif');
	assert.equal(sniffImageMimeType(buffer(bytes('RIFF\0\0\0\0WEBPVP8 '))), 'image/webp');
	assert.equal(sniffImageMimeType(buffer(bytes('\0\0\0\x1cftypavif\0\0\0\0'))), 'image/avif');
	assert.equal(sniffImageMimeType(buffer(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))), 'image/svg+xml');
	assert.equal(sniffImageMimeType(buffer(bytes('<?xml version="1.0"?>\n<svg width="1"></svg>'))), 'image/svg+xml');
});

test('sniffer rejects HTML, JSON, video containers and empty bodies', () => {
	assert.equal(sniffImageMimeType(buffer(bytes('<!DOCTYPE html><html><body><svg></svg></body></html>'))), null);
	assert.equal(sniffImageMimeType(buffer(bytes('<html><head></head></html>'))), null);
	assert.equal(sniffImageMimeType(buffer(bytes('{"error":"unauthorized"}'))), null);
	assert.equal(sniffImageMimeType(buffer(bytes('\0\0\0\x1cftypisom\0\0\0\0'))), null);
	assert.equal(sniffImageMimeType(new ArrayBuffer(0)), null);
});

function createHandler(settings = {}) {
	const uploadService = {
		uploads: [],
		async uploadImage(file) {
			this.uploads.push({ name: file.name, type: file.type });
			return `https://img.example/${file.name}`;
		}
	};
	const app = {
		vault: { getAbstractFileByPath: () => null, adapter: {} },
		metadataCache: { getFirstLinkpathDest: () => null },
		workspace: { getActiveFile: () => null, getActiveViewOfType: () => null }
	};
	const handler = new ImageHandler(app, uploadService, () => ({
		apiUrl: 'https://img.example',
		excludedImageDomains: [],
		enableNetworkImageUpload: true,
		...settings
	}));
	return { handler, uploadService };
}

test('an intranet page answering 200 text/html is never wrapped as a PNG and uploaded', async () => {
	const { handler, uploadService } = createHandler({ allowPrivateNetworkImageFetch: true });
	globalThis.__requestUrl = async () => ({
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8' },
		arrayBuffer: buffer(bytes('<!DOCTYPE html><html><body>admin</body></html>'))
	});
	const note = new TFile('notes/a.md');
	const content = '![x](http://127.0.0.1:8080/admin)';

	const result = await handler.uploadImagesInText(content, note, note.path);

	assert.equal(result.success, 0);
	assert.equal(result.failed, 1);
	assert.deepEqual(uploadService.uploads, []);
	assert.equal(result.content, content);
});

test('a lying image/png header on an HTML body is rejected too', async () => {
	const { handler, uploadService } = createHandler();
	globalThis.__requestUrl = async () => ({
		status: 200,
		headers: { 'content-type': 'image/png' },
		arrayBuffer: buffer(bytes('<html><body>login</body></html>'))
	});
	const note = new TFile('notes/a.md');
	const result = await handler.uploadImagesInText('![x](https://site.example/pic.png)', note, note.path);
	assert.equal(result.success, 0);
	assert.deepEqual(uploadService.uploads, []);
});

test('a real image without a usable content-type is still uploaded with the sniffed type', async () => {
	const { handler, uploadService } = createHandler();
	globalThis.__requestUrl = async () => ({
		status: 200,
		headers: { 'content-type': 'application/octet-stream' },
		arrayBuffer: buffer(PNG)
	});
	const note = new TFile('notes/a.md');
	const result = await handler.uploadImagesInText('![pic](https://site.example/download?id=1)', note, note.path);
	assert.equal(result.success, 1);
	assert.deepEqual(uploadService.uploads, [{ name: 'pic.png', type: 'image/png' }]);
});

test('hosts are classified as public or private, including the usual disguises', () => {
	for (const url of [
		'http://localhost:8080/a.png', 'http://127.0.0.1/a.png', 'http://2130706433/a.png', 'http://0x7f.1/a.png',
		'http://0.0.0.0/a.png', 'http://10.1.2.3/a.png', 'http://172.16.0.9/a.png', 'http://192.168.2.191:7658/a.png',
		'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/a.png', 'http://[::1]/a.png', 'http://[fe80::1]/a.png',
		'http://[fd12:3456::1]/a.png', 'http://[::ffff:192.168.1.1]/a.png', 'http://router.local/a.png', 'http://nas/a.png',
		'http://printer.lan/a.png'
	]) {
		assert.equal(classifyRemoteHost(url), 'private', url);
	}
	for (const url of ['https://example.com/a.png', 'http://8.8.8.8/a.png', 'http://172.32.0.1/a.png', 'https://[2606:4700::1111]/a.png']) {
		assert.equal(classifyRemoteHost(url), 'public', url);
	}
	for (const url of ['ftp://example.com/a.png', 'file:///etc/hosts', 'not a url']) {
		assert.equal(classifyRemoteHost(url), 'invalid', url);
	}
});

test('by default images on loopback / private addresses are skipped without any request being made', async () => {
	const { handler, uploadService } = createHandler();
	let requests = 0;
	globalThis.__requestUrl = async () => { requests++; return { status: 200, headers: { 'content-type': 'image/png' }, arrayBuffer: buffer(PNG) }; };
	const note = new TFile('notes/a.md');
	const content = '![cam](http://192.168.1.10:8081/snapshot.jpg)\n![admin](http://127.0.0.1:8080/logo.png)\n![r](http://router.local/x.png)';

	const result = await handler.uploadImagesInText(content, note, note.path);

	assert.equal(requests, 0);
	assert.equal(result.success, 0);
	assert.equal(result.failed, 0, 'skipped, not failed: auto-upload must not retry these');
	assert.equal(result.content, content);
	assert.deepEqual(uploadService.uploads, []);
	assert.equal(handler.countUploadableImages(content), 0);
});

test('private addresses are fetched once the user explicitly allows them', async () => {
	const { handler, uploadService } = createHandler({ allowPrivateNetworkImageFetch: true });
	globalThis.__requestUrl = async () => ({ status: 200, headers: { 'content-type': 'image/png' }, arrayBuffer: buffer(PNG) });
	const note = new TFile('notes/a.md');
	const result = await handler.uploadImagesInText('![nas](http://192.168.2.50/photo.png)', note, note.path);
	assert.equal(result.success, 1);
	assert.equal(uploadService.uploads.length, 1);
});

test('wildcard-DNS names and deprecated IPv4-compatible IPv6 literals are treated as private', () => {
	for (const url of ['http://127.0.0.1.nip.io/a.png', 'http://app.10-0-0-5.sslip.io/a.png', 'http://lvh.me/a.png', 'http://[::127.0.0.1]/a.png', 'http://[::c0a8:101]/a.png']) {
		assert.equal(classifyRemoteHost(url), 'private', url);
	}
	assert.equal(classifyRemoteHost('http://[::808:808]/a.png'), 'public');
});
