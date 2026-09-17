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
export class TFile { constructor(p) { this.path = p; this.name = p.split('/').pop(); this.extension = this.name.split('.').pop(); } }
export class Notice { constructor(message) { (globalThis.__notices ??= []).push(String(message)); } }
export class MarkdownView {}
export const Platform = { isMobile: false };
export const requestUrl = (...args) => globalThis.__requestUrl(...args);
// 极简 HTML→Markdown：<img> 转成 Markdown 图片，段落转空行，其余标签去掉
export const htmlToMarkdown = (html) => html
	.replace(/<img[^>]*src="([^"]+)"[^>]*>/g, '![]($1)')
	.replace(/<\\/p>/g, '\\n\\n')
	.replace(/<[^>]+>/g, '');
`;
const stubObsidian = {
	name: 'stub-obsidian',
	setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: obsidianStub, loader: 'js' }));
	}
};

const buildDir = await mkdtemp(path.join(tmpdir(), 'cf-imgbed-stash-test-'));
after(() => rm(buildDir, { recursive: true, force: true }));
const outfile = path.join(buildDir, 'imageHandler.mjs');
await build({
	stdin: {
		contents: "export { ImageHandler } from './src/upload/imageHandler.ts'; export { TFile } from 'obsidian';",
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
const { ImageHandler, TFile } = await import(pathToFileURL(outfile).href);

function createApp(note, { failCreate = false } = {}) {
	const created = [];
	return {
		created,
		vault: {
			async createBinary(p, data) {
				if (failCreate) {
					throw new Error('disk full');
				}
				created.push({ path: p, bytes: new Uint8Array(data).length });
				return new TFile(p);
			}
		},
		fileManager: {
			async getAvailablePathForAttachment(name, sourcePath) {
				return `attachments/${sourcePath ? 'note-' : ''}${name}`;
			},
			generateMarkdownLink(file) {
				return `[[${file.path}]]`;
			}
		},
		workspace: {
			getActiveFile: () => note,
			getActiveViewOfType: () => null
		}
	};
}

/** 带真实文本缓冲和选区的最小编辑器：offset 直接当作位置。 */
function createEditor(text = '', selection = [text.length, text.length]) {
	return {
		text,
		selection,
		getValue() { return this.text; },
		offsetToPos: (offset) => offset,
		replaceSelection(value) {
			const [from, to] = this.selection;
			this.replaceRange(value, from, to);
			this.selection = [from + value.length, from + value.length];
		},
		replaceRange(value, from, to) {
			this.text = this.text.slice(0, from) + value + this.text.slice(to);
		}
	};
}

function createHandler(app, settings, uploadResult) {
	const uploadService = { async uploadImage() { return uploadResult; } };
	const i18n = { t: (key, params) => `${key}${params ? ' ' + JSON.stringify(params) : ''}` };
	return new ImageHandler(app, uploadService, () => settings, i18n);
}

/** 模拟在编辑器里粘贴一张图片。 */
async function pasteImage(handler, editor, bytes = [1, 2, 3]) {
	const file = new NodeFile([Uint8Array.from(bytes)], 'image.png', { type: 'image/png' });
	const event = {
		clipboardData: {
			items: [{ type: 'image/png', getAsFile: () => file }],
			getData: () => ''
		},
		preventDefault() {},
		stopPropagation() {}
	};
	await handler.handleEditorPaste(event, editor);
}

const baseSettings = { showUploadProgress: false, showSuccessNotification: false, notificationDuration: 1 };

test('a failed paste upload is stashed in the attachment folder with a local embed, and auto-upload will retry it', async () => {
	globalThis.__notices = [];
	const note = new TFile('inbox/a.md');
	const app = createApp(note);
	const editor = createEditor();
	const handler = createHandler(app, { ...baseSettings, enableAutoUpload: true, autoUploadFolders: 'inbox', autoUploadWholeVault: false }, null);

	await pasteImage(handler, editor);

	assert.deepEqual(app.created, [{ path: 'attachments/note-image.png', bytes: 3 }]);
	assert.equal(editor.text, '![[attachments/note-image.png]]');
	assert.ok(globalThis.__notices.some((message) => message.startsWith('notices.uploadFailedStashedAuto')));
});

test('outside the auto-upload scope the user is told to retry manually', async () => {
	globalThis.__notices = [];
	const note = new TFile('notes/a.md');
	const app = createApp(note);
	const editor = createEditor();
	const handler = createHandler(app, { ...baseSettings, enableAutoUpload: true, autoUploadFolders: 'inbox', autoUploadWholeVault: false }, null);

	await pasteImage(handler, editor);

	assert.equal(app.created.length, 1);
	assert.ok(globalThis.__notices.some((message) => message.startsWith('notices.uploadFailedStashedManual')));
	assert.ok(!globalThis.__notices.some((message) => message.startsWith('notices.uploadFailedStashedAuto')));
});

test('when stashing itself fails nothing is inserted and the failure is reported, never success', async () => {
	globalThis.__notices = [];
	const note = new TFile('inbox/a.md');
	const app = createApp(note, { failCreate: true });
	const editor = createEditor();
	const handler = createHandler(app, { ...baseSettings, enableAutoUpload: true, autoUploadWholeVault: true }, null);

	await pasteImage(handler, editor);

	assert.equal(editor.text, '');
	assert.ok(globalThis.__notices.some((message) => message === 'notices.uploadFailedStashFailed'));
	assert.ok(!globalThis.__notices.some((message) => message.startsWith('notices.uploadSuccess')));
});

test('a successful upload never touches the vault', async () => {
	globalThis.__notices = [];
	const app = createApp(new TFile('inbox/a.md'));
	const editor = createEditor();
	const handler = createHandler(app, { ...baseSettings, enableAutoUpload: true, autoUploadWholeVault: true }, 'https://img.example/ok.png');

	await pasteImage(handler, editor);

	assert.equal(app.created.length, 0);
	assert.equal(editor.text, '![image.png](https://img.example/ok.png)');
});

// ---- 异步上传的落点：占位符 ----

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** 上传会挂起，直到测试调用 release(url)，用来模拟「上传期间用户继续编辑」。 */
function createDeferredHandler(app, settings = baseSettings) {
	let release;
	const pending = new Promise((resolve) => { release = resolve; });
	const uploadService = { uploadImage: () => pending };
	const i18n = { t: (key, params) => `${key}${params ? ' ' + JSON.stringify(params) : ''}` };
	return { handler: new ImageHandler(app, uploadService, () => settings, i18n), release };
}

test('text the user selects while the upload is running is not overwritten', async () => {
	const app = createApp(new TFile('inbox/a.md'));
	const editor = createEditor('before  after', [7, 7]);
	const { handler, release } = createDeferredHandler(app);

	const paste = pasteImage(handler, editor);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.match(editor.text, /^before !\[⏳ image\.png \w+\]\(\) after$/);
	// 用户在上传期间选中了开头的 "before"
	editor.selection = [0, 6];
	release('https://img.example/ok.png');
	await paste;

	assert.equal(editor.text, 'before ![image.png](https://img.example/ok.png) after');
});

test('if the user deletes the placeholder nothing is inserted at the cursor', async () => {
	globalThis.__notices = [];
	const app = createApp(new TFile('inbox/a.md'));
	const editor = createEditor('');
	const { handler, release } = createDeferredHandler(app);

	const paste = pasteImage(handler, editor);
	await new Promise((resolve) => setTimeout(resolve, 5));
	editor.text = 'user rewrote everything';
	editor.selection = [0, 4];
	release('https://img.example/ok.png');
	await paste;

	assert.equal(editor.text, 'user rewrote everything');
	assert.ok(globalThis.__notices.some((message) => message.startsWith('notices.uploadPlaceholderLost')));
});

test('when the note was closed during the upload the placeholder is resolved on disk', async () => {
	const note = new TFile('inbox/a.md');
	const app = createApp(note);
	const editor = createEditor('');
	let disk = null;
	app.workspace.getLeavesOfType = () => [];
	app.vault.process = async (file, update) => { disk = update(disk); return disk; };
	const { handler, release } = createDeferredHandler(app);

	const paste = pasteImage(handler, editor);
	await new Promise((resolve) => setTimeout(resolve, 5));
	disk = `intro\n${editor.text}\n`;
	const detachedText = editor.text;
	release('https://img.example/ok.png');
	await paste;

	assert.equal(disk, 'intro\n![image.png](https://img.example/ok.png)\n');
	assert.equal(editor.text, detachedText, 'a detached editor must not be written to');
});

test('rich-text paste keeps the body text and only swaps the image links', async () => {
	globalThis.__notices = [];
	globalThis.DOMParser = class {
		parseFromString(html) {
			const images = Array.from(html.matchAll(/<img[^>]*src="([^"]+)"[^>]*>/g)).map((match) => ({
				getAttribute: (name) => (name === 'src' ? match[1] : null)
			}));
			return { querySelectorAll: () => images };
		}
	};
	globalThis.__requestUrl = async () => ({
		status: 200,
		headers: { 'content-type': 'image/png' },
		arrayBuffer: PNG_BYTES.buffer.slice(0)
	});
	const app = createApp(new TFile('inbox/a.md'));
	const editor = createEditor('');
	const uploadService = { async uploadImage(file) { return `https://img.example/${file.name}`; } };
	const settings = { ...baseSettings, enableNetworkImageUpload: true, apiUrl: 'https://img.example', excludedImageDomains: [] };
	const handler = new ImageHandler(app, uploadService, () => settings, { t: (key) => key });
	const html = '<p>First paragraph.</p><img src="https://site.example/pic.png"><p>Second paragraph.</p>';
	const event = {
		clipboardData: {
			items: [],
			getData: (type) => (type === 'text/html' ? html : 'First paragraph.\n\nSecond paragraph.')
		},
		preventDefault() {},
		stopPropagation() {}
	};

	await handler.handleEditorPaste(event, editor);

	assert.equal(editor.text, 'First paragraph.\n\n![](https://img.example/pic.png)Second paragraph.');
});
