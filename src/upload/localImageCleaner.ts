import { App, EventRef, MarkdownView, Notice, TFile, requestUrl } from 'obsidian';
import { CFImageBedSettings } from '../types';
import { I18n } from '../utils/i18n';
import { sha256Hex } from '../utils/contentHash';
import { UploadIndex, buildProcessingPolicy, buildUploadIndexKey, buildUploadNamespace } from './uploadIndex';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'apng', 'heic', 'heif', 'ico']);

/** 一张已成功上传、且来自库内文件的图片。 */
export interface UploadedVaultImage {
	file: TFile;
	/** 服务端返回的 src，用于和去重索引核对。 */
	src: string;
	/** 用于远端验证的完整链接。 */
	url: string;
}

export type KeepReason =
	| 'disabled'
	| 'dedupe-disabled'
	| 'resolve-timeout'
	| 'missing'
	| 'not-in-index'
	| 'hash-mismatch'
	| 'changed'
	| 'referenced'
	| 'unsaved-edit'
	| 'remote-unverified'
	| 'error';

export interface CleanupReport {
	deleted: string[];
	kept: { path: string; reason: KeepReason }[];
}

/** 写回前创建：提前监听 metadataCache 的 resolve(file)，写回后等待它完成再检查引用。 */
export interface ResolveWaiter {
	wait(timeoutMs?: number): Promise<boolean>;
	dispose(): void;
}

type Fetcher = typeof requestUrl;

interface FileStamp {
	mtime: number;
	size: number;
}

/**
 * 上传成功后的本地图片清理。图床即将成为唯一副本，因此删除前逐项核对，任何一项不满足都保留原图：
 *
 *  1. 等待源笔记的链接解析完成（resolve 事件，写回前已注册；超时保留）。
 *  2. 全库引用检查：resolvedLinks + 所有 .canvas（解析失败视为有引用）+ 全文按文件名搜索
 *     （先剔除指向远程 URL 的图片/链接/<img> 结构和裸 URL，再做 HTML 实体与百分号解码，
 *     覆盖 `pic%201.png`、`&amp;` 这类写法）+ 所有打开视图中的内容（Markdown 编辑器、
 *     可读取 getViewData 的 Canvas/Excalidraw 等文本视图；无法读取内容的文件视图一律视为有引用）。
 *  3. 当前字节重新哈希，必须命中去重索引且 src 一致；哈希前后核对 mtime/size（图片被覆盖过则保留）。
 *     哈希放在本地检查的最后一步，异步全库扫描之后。
 *  4. 远端验证：HEAD/GET 必须 200，且 Content-Type 为 image/*，或 GET 响应体带有图片魔数；
 *     无法确认类型不放行。
 *  5. 远端验证有网络等待，结束后把 2、3 再做一遍，进回收站前再核对一次 mtime/size，
 *     然后 fileManager.trashFile（遵守 Obsidian 的删除设置）。
 *
 * 孤立图片清理（命令）走同一条流水线，只是把「本次上传」换成「当前字节命中索引」。
 */
export class LocalImageCleaner {
	static resolveTimeoutMs = 15000;

	private textCache = new Map<string, { mtime: number; text: string }>();

	constructor(
		private app: App,
		private uploadIndex: UploadIndex,
		private getSettings: () => CFImageBedSettings,
		private buildUrl: (src: string) => string,
		private i18n: I18n,
		private fetcher: Fetcher = requestUrl
	) {}

	isEnabled(): boolean {
		return Boolean(this.getSettings()?.deleteLocalAfterUpload);
	}

	expectResolve(file: TFile): ResolveWaiter {
		let resolved = false;
		let notify: (() => void) | null = null;
		const ref: EventRef = this.app.metadataCache.on('resolve', (resolvedFile: TFile) => {
			if (resolvedFile.path === file.path) {
				resolved = true;
				notify?.();
			}
		});
		const dispose = () => this.app.metadataCache.offref(ref);
		return {
			wait: (timeoutMs = LocalImageCleaner.resolveTimeoutMs) => {
				if (resolved) {
					return Promise.resolve(true);
				}
				return new Promise<boolean>((resolve) => {
					const timer = setTimeout(() => {
						notify = null;
						resolve(false);
					}, timeoutMs);
					notify = () => {
						clearTimeout(timer);
						resolve(true);
					};
				});
			},
			dispose
		};
	}

	/** 链接写回之后调用。 */
	async cleanupAfterWriteBack(images: UploadedVaultImage[], sourceFile: TFile, waiter: ResolveWaiter): Promise<CleanupReport> {
		const report: CleanupReport = { deleted: [], kept: [] };
		try {
			if (images.length === 0) {
				return report;
			}
			if (!this.isEnabled()) {
				images.forEach((image) => report.kept.push({ path: image.file.path, reason: 'disabled' }));
				return report;
			}
			const resolved = await waiter.wait();
			if (!resolved) {
				images.forEach((image) => report.kept.push({ path: image.file.path, reason: 'resolve-timeout' }));
				return report;
			}
			void sourceFile;
			for (const image of images) {
				await this.cleanupOne(image, report);
			}
			return report;
		} finally {
			waiter.dispose();
			this.notify(report);
		}
	}

	/** 孤立图片：库内图片文件，当前字节命中索引，且全库无引用。 */
	async findOrphans(): Promise<UploadedVaultImage[]> {
		const orphans: UploadedVaultImage[] = [];
		for (const file of this.app.vault.getFiles()) {
			if (!IMAGE_EXTENSIONS.has(file.extension.toLowerCase())) {
				continue;
			}
			const indexed = await this.lookupIndex(file);
			if (!indexed) {
				continue;
			}
			if (await this.isReferenced(file) || this.hasOpenViewReference(file)) {
				continue;
			}
			orphans.push({ file, src: indexed.src, url: this.buildUrl(indexed.src) });
		}
		return orphans;
	}

	/** 用户在预览中确认后调用；每张图在真正删除前都会再完整核对一次。 */
	async cleanupOrphans(images: UploadedVaultImage[]): Promise<CleanupReport> {
		const report: CleanupReport = { deleted: [], kept: [] };
		for (const image of images) {
			await this.cleanupOne(image, report);
		}
		this.notify(report);
		return report;
	}

	private async cleanupOne(image: UploadedVaultImage, report: CleanupReport): Promise<void> {
		const path = image.file.path;
		try {
			const precheck = await this.check(image);
			if (precheck.reason) {
				report.kept.push({ path, reason: precheck.reason });
				return;
			}
			if (!(await this.verifyRemote(image.url))) {
				report.kept.push({ path, reason: 'remote-unverified' });
				return;
			}
			// 远端验证期间本地图片或引用可能已变化：进回收站前再完整复核一次
			const recheck = await this.check(image);
			if (recheck.reason) {
				report.kept.push({ path, reason: recheck.reason });
				return;
			}
			// 复核里的哈希是最后一步异步操作；这里再核对一次文件身份，中间没有其他异步扫描
			const current = this.app.vault.getAbstractFileByPath(path);
			if (!(current instanceof TFile)) {
				report.kept.push({ path, reason: 'missing' });
				return;
			}
			if (!sameStamp(stampOf(current), recheck.stamp)) {
				report.kept.push({ path, reason: 'changed' });
				return;
			}
			await this.app.fileManager.trashFile(current);
			report.deleted.push(path);
		} catch (error) {
			console.error(`CF ImageBed: cleanup of ${path} failed:`, error);
			report.kept.push({ path, reason: 'error' });
		}
	}

	/**
	 * 本地侧的全部前置条件。顺序：存在 → 引用（异步全库扫描）→ 打开的视图 → 哈希（最后，
	 * 并核对哈希前后的 mtime/size），这样哈希到删除之间不再夹任何异步扫描。
	 */
	private async check(image: UploadedVaultImage): Promise<{ reason: KeepReason | null; stamp: FileStamp | null }> {
		const settings = this.getSettings();
		if (settings?.enableUploadDedupe === false) {
			return { reason: 'dedupe-disabled', stamp: null };
		}
		let current = this.app.vault.getAbstractFileByPath(image.file.path);
		if (!(current instanceof TFile)) {
			return { reason: 'missing', stamp: null };
		}
		if (await this.isReferenced(current)) {
			return { reason: 'referenced', stamp: null };
		}
		if (this.hasOpenViewReference(current)) {
			return { reason: 'unsaved-edit', stamp: null };
		}

		current = this.app.vault.getAbstractFileByPath(image.file.path);
		if (!(current instanceof TFile)) {
			return { reason: 'missing', stamp: null };
		}
		const before = stampOf(current);
		const indexed = await this.lookupIndex(current);
		const after = this.app.vault.getAbstractFileByPath(image.file.path);
		if (!(after instanceof TFile) || !sameStamp(stampOf(after), before)) {
			return { reason: 'changed', stamp: null };
		}
		if (!indexed) {
			return { reason: 'not-in-index', stamp: null };
		}
		if (indexed.src !== image.src) {
			return { reason: 'hash-mismatch', stamp: null };
		}
		return { reason: null, stamp: before };
	}

	/** 重新哈希当前字节，按当前设置构造去重键查索引。 */
	private async lookupIndex(file: TFile): Promise<{ src: string } | null> {
		const settings = this.getSettings();
		const bytes = await this.app.vault.readBinary(file);
		const hash = await sha256Hex(bytes);
		const key = buildUploadIndexKey(hash, buildUploadNamespace(settings), buildProcessingPolicy(settings));
		const entry = this.uploadIndex.get(key);
		return entry ? { src: entry.src } : null;
	}

	private async isReferenced(file: TFile): Promise<boolean> {
		const resolvedLinks = this.app.metadataCache.resolvedLinks ?? {};
		for (const links of Object.values(resolvedLinks)) {
			if (links && links[file.path] > 0) {
				return true;
			}
		}

		for (const { file: other, text } of await this.getVaultTexts()) {
			if (textReferencesImage(text, other.extension, file)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 所有打开的视图：Markdown 编辑器读 editor 内容；带 getViewData 的文本视图（Canvas、Excalidraw…）
	 * 读其当前数据；正在查看该图片本身、或打开了无法读取内容的笔记/画布视图，都按「有引用」处理。
	 */
	private hasOpenViewReference(file: TFile): boolean {
		let referenced = false;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (referenced) {
				return;
			}
			const view = leaf.view as unknown as {
				file?: TFile | null;
				editor?: { getValue(): string };
				getViewData?: () => string;
			};
			try {
				if (view instanceof MarkdownView) {
					referenced = textReferencesImage(view.editor.getValue(), 'md', file);
					return;
				}
				const viewFile = view.file ?? null;
				if (viewFile && viewFile.path === file.path) {
					referenced = true; // 正在查看这张图片
					return;
				}
				if (typeof view.getViewData === 'function') {
					const ext = viewFile?.extension ?? 'md';
					referenced = textReferencesImage(view.getViewData(), ext, file);
					return;
				}
				if (viewFile && (viewFile.extension === 'md' || viewFile.extension === 'canvas')) {
					referenced = true; // 内容无法确认的笔记/画布视图
				}
			} catch {
				referenced = true;
			}
		});
		return referenced;
	}

	/**
	 * 全库 Markdown + Canvas 文本，按 mtime 增量刷新：同一批清理里多张图共享一次读取，
	 * 修改过的文件按需重读，不会误用过期内容。
	 */
	private async getVaultTexts(): Promise<{ file: TFile; text: string }[]> {
		const files = this.app.vault.getFiles().filter((file) => file.extension === 'md' || file.extension === 'canvas');
		const seen = new Set<string>();
		const result: { file: TFile; text: string }[] = [];
		for (const file of files) {
			seen.add(file.path);
			const mtime = file.stat?.mtime ?? 0;
			const cached = this.textCache.get(file.path);
			if (cached && cached.mtime === mtime) {
				result.push({ file, text: cached.text });
				continue;
			}
			const text = await this.app.vault.cachedRead(file);
			this.textCache.set(file.path, { mtime, text });
			result.push({ file, text });
		}
		for (const path of Array.from(this.textCache.keys())) {
			if (!seen.has(path)) {
				this.textCache.delete(path);
			}
		}
		return result;
	}

	/**
	 * 远端必须真的是一张图片：HEAD 200 且 Content-Type 为 image/* 即可；
	 * 否则 GET，要求 200 且（image/* 或响应体带图片魔数）。无法确认类型不放行。
	 */
	private async verifyRemote(url: string): Promise<boolean> {
		try {
			const head = await this.fetcher({ url, method: 'HEAD', throw: false });
			if (head.status === 200 && contentTypeOf(head.headers).startsWith('image/')) {
				return true;
			}
		} catch (error) {
			console.warn(`CF ImageBed: remote verification (HEAD) failed for ${url}`, error);
		}
		try {
			const get = await this.fetcher({ url, method: 'GET', throw: false });
			if (get.status !== 200) {
				return false;
			}
			if (contentTypeOf(get.headers).startsWith('image/')) {
				return true;
			}
			return looksLikeImageBytes(get.arrayBuffer);
		} catch (error) {
			console.warn(`CF ImageBed: remote verification (GET) failed for ${url}`, error);
			return false;
		}
	}

	private notify(report: CleanupReport): void {
		const settings = this.getSettings();
		if (report.deleted.length === 0 && report.kept.every((item) => item.reason === 'disabled')) {
			return;
		}
		const reasons = new Map<KeepReason, number>();
		for (const item of report.kept) {
			reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
		}
		const keptText = Array.from(reasons.entries())
			.map(([reason, count]) => `${this.i18n.t(`cleanup.reasons.${reason}`)} ×${count}`)
			.join('，');
		if (report.deleted.length === 0 && report.kept.length === 0) {
			return;
		}
		new Notice(
			this.i18n.t('cleanup.summary', {
				deleted: report.deleted.length,
				kept: report.kept.length,
				reasons: keptText ? `（${keptText}）` : ''
			}),
			(settings?.notificationDuration ?? 5) * 1000
		);
	}
}

function stampOf(file: TFile): FileStamp {
	return { mtime: file.stat?.mtime ?? 0, size: file.stat?.size ?? 0 };
}

function sameStamp(a: FileStamp, b: FileStamp | null): boolean {
	return b !== null && a.mtime === b.mtime && a.size === b.size;
}

function contentTypeOf(headers: Record<string, string> | undefined): string {
	if (!headers) {
		return '';
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === 'content-type') {
			return (value || '').toLowerCase();
		}
	}
	return '';
}

/** 常见图片格式的魔数：PNG / JPEG / GIF / WebP / BMP / ISO-BMFF(AVIF, HEIC) / SVG 文本。 */
export function looksLikeImageBytes(buffer: ArrayBuffer | undefined): boolean {
	if (!buffer || buffer.byteLength < 4) {
		return false;
	}
	const bytes = new Uint8Array(buffer.slice(0, 64));
	const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
	if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG') return true;
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
	if (ascii(0, 4) === 'GIF8') return true;
	if (ascii(0, 4) === 'RIFF' && bytes.byteLength >= 12 && ascii(8, 4) === 'WEBP') return true;
	if (ascii(0, 2) === 'BM') return true;
	if (bytes.byteLength >= 12 && ascii(4, 4) === 'ftyp') return true;
	const text = new TextDecoder().decode(bytes).trimStart().toLowerCase();
	return text.startsWith('<svg') || text.startsWith('<?xml');
}

/** 文本（Markdown / Canvas / 视图数据）是否引用了该库内图片。 */
export function textReferencesImage(text: string, extension: string, file: TFile): boolean {
	if (extension === 'canvas') {
		return canvasReferences(text, file);
	}
	return mentionsLocalFile(text, file.name);
}

/**
 * 文本里是否提到该本地文件名。步骤：
 *  1. 删除指向远程 URL 的 Markdown 图片/链接（含 alt，上传后 `![pic.png](https://…/pic.png)` 的 alt 里仍是原文件名）、
 *     `<img src="http…">` 标签、以及裸 URL —— 远程链接不可能引用库内文件。
 *  2. 解码 HTML 实体与百分号编码，让 `pic%201.png`、`pic&#32;1.png` 与 `pic 1.png` 一致。
 *  3. 小写后做子串匹配。
 */
export function mentionsLocalFile(text: string, fileName: string): boolean {
	const stripped = text
		.replace(/!?\[[^\]]*\]\(\s*<?https?:\/\/[^)]*\)/gi, ' ')
		.replace(/<img\b[^>]*\bsrc\s*=\s*["']?https?:[^>]*>/gi, ' ')
		.replace(/https?:\/\/[^\s)>"'\]]+/gi, ' ');
	const normalized = safeDecodePercent(decodeHtmlEntities(stripped)).toLowerCase();
	const needle = safeDecodePercent(decodeHtmlEntities(fileName)).toLowerCase();
	return normalized.includes(needle);
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
		.replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name: string) => {
			switch (name.toLowerCase()) {
				case 'amp': return '&';
				case 'lt': return '<';
				case 'gt': return '>';
				case 'quot': return '"';
				case 'apos': return "'";
				default: return ' ';
			}
		});
}

function safeFromCodePoint(codePoint: number): string {
	try {
		return String.fromCodePoint(codePoint);
	} catch {
		return '';
	}
}

function safeDecodePercent(value: string): string {
	// 逐段解码：某一段非法不影响其余部分
	return value.replace(/(%[0-9a-f]{2})+/gi, (match) => {
		try {
			return decodeURIComponent(match);
		} catch {
			return match;
		}
	});
}

/** Canvas 是 JSON：解析失败按「有引用」处理；file 节点路径相同或原文出现文件名都算引用。 */
function canvasReferences(text: string, file: TFile): boolean {
	try {
		const parsed = JSON.parse(text) as { nodes?: { type?: string; file?: string }[] };
		if (parsed?.nodes?.some((node) => typeof node.file === 'string' && node.file === file.path)) {
			return true;
		}
	} catch {
		return true;
	}
	return mentionsLocalFile(text, file.name);
}
