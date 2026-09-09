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
export const requestUrl = () => { throw new Error('network disabled in test'); };
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

function createEditor() {
	return { inserted: [], replaceSelection(text) { this.inserted.push(text); } };
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
	assert.deepEqual(editor.inserted, ['![[attachments/note-image.png]]']);
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

	assert.deepEqual(editor.inserted, []);
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
	assert.deepEqual(editor.inserted, ['![image.png](https://img.example/ok.png)']);
});
