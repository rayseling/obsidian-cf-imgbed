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

/**
 * 上传成功后的本地图片清理。图床即将成为唯一副本，因此删除前逐项核对，任何一项不满足都保留原图：
 *
 *  1. 等待源笔记的链接解析完成（resolve 事件，写回前已注册；超时保留）。
 *  2. 当前字节重新哈希，必须命中去重索引且 src 一致（图片被覆盖过则保留）。
 *  3. 全库引用检查：resolvedLinks + 所有 .canvas（解析失败视为有引用）+ 全文按文件名搜索
 *     （覆盖 HTML <img>、Excalidraw 等无法结构化识别的引用）+ 所有打开编辑器中的未保存内容。
 *  4. 远端验证：链接可访问且响应是图片。
 *  5. 远端验证有网络等待，结束后把 2、3 再做一遍，然后 fileManager.trashFile（遵守 Obsidian 的删除设置）。
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
			if (await this.isReferenced(file) || this.hasUnsavedReference(file)) {
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
			if (precheck) {
				report.kept.push({ path, reason: precheck });
				return;
			}
			if (!(await this.verifyRemote(image.url))) {
				report.kept.push({ path, reason: 'remote-unverified' });
				return;
			}
			// 远端验证期间本地图片或引用可能已变化：进回收站前再完整复核一次
			const recheck = await this.check(image);
			if (recheck) {
				report.kept.push({ path, reason: recheck });
				return;
			}
			const current = this.app.vault.getAbstractFileByPath(path);
			if (!(current instanceof TFile)) {
				report.kept.push({ path, reason: 'missing' });
				return;
			}
			await this.app.fileManager.trashFile(current);
			report.deleted.push(path);
		} catch (error) {
			console.error(`CF ImageBed: cleanup of ${path} failed:`, error);
			report.kept.push({ path, reason: 'error' });
		}
	}

	/** 本地侧的全部前置条件；返回 null 表示都满足。 */
	private async check(image: UploadedVaultImage): Promise<KeepReason | null> {
		const settings = this.getSettings();
		if (settings?.enableUploadDedupe === false) {
			return 'dedupe-disabled';
		}
		const current = this.app.vault.getAbstractFileByPath(image.file.path);
		if (!(current instanceof TFile)) {
			return 'missing';
		}
		const indexed = await this.lookupIndex(current);
		if (!indexed) {
			return 'not-in-index';
		}
		if (indexed.src !== image.src) {
			return 'hash-mismatch';
		}
		if (await this.isReferenced(current)) {
			return 'referenced';
		}
		if (this.hasUnsavedReference(current)) {
			return 'unsaved-edit';
		}
		return null;
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

		const needle = file.name.toLowerCase();
		for (const { file: other, text } of await this.getVaultTexts()) {
			if (other.extension === 'canvas') {
				if (canvasReferences(text, file.path, needle)) {
					return true;
				}
				continue;
			}
			if (mentionsLocalFile(text, needle)) {
				return true;
			}
		}
		return false;
	}

	/** 所有打开的 Markdown 编辑器（无论是否已保存）只要提到该文件名就视为仍在引用。 */
	private hasUnsavedReference(file: TFile): boolean {
		const needle = file.name.toLowerCase();
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) {
				continue;
			}
			try {
				if (mentionsLocalFile(view.editor.getValue(), needle)) {
					return true;
				}
			} catch {
				return true; // 读不到编辑器内容也按有引用处理
			}
		}
		return false;
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

	private async verifyRemote(url: string): Promise<boolean> {
		for (const method of ['HEAD', 'GET']) {
			try {
				const response = await this.fetcher({ url, method, throw: false });
				if (response.status !== 200) {
					continue;
				}
				const contentType = (response.headers?.['content-type'] || response.headers?.['Content-Type'] || '').toLowerCase();
				if (contentType && !contentType.startsWith('image/')) {
					return false;
				}
				return true;
			} catch (error) {
				console.warn(`CF ImageBed: remote verification (${method}) failed for ${url}`, error);
			}
		}
		return false;
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

/**
 * 文本里是否提到该本地文件名。先去掉所有 http(s) 链接：远程 URL 不可能引用库内文件，
 * 而上传后的图床链接通常保留原文件名，不去掉会把每一张已上云的图都误判为「仍被引用」。
 */
function mentionsLocalFile(text: string, needle: string): boolean {
	const withoutUrls = text.replace(/https?:\/\/[^\s)>"'\]]+/gi, ' ');
	return withoutUrls.toLowerCase().includes(needle);
}

/** Canvas 是 JSON：解析失败按「有引用」处理；file 节点路径相同或原文出现文件名都算引用。 */
function canvasReferences(text: string, imagePath: string, needle: string): boolean {
	try {
		const parsed = JSON.parse(text) as { nodes?: { type?: string; file?: string }[] };
		if (parsed?.nodes?.some((node) => typeof node.file === 'string' && node.file === imagePath)) {
			return true;
		}
	} catch {
		return true;
	}
	return mentionsLocalFile(text, needle);
}
