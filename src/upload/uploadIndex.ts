import type { CFImageBedSettings } from '../types';

export interface UploadIndexEntry {
	/** 服务端返回的相对路径（如 /file/xxx.png），返回链接按当前设置重新拼接。 */
	src: string;
	/** 首次上传时的文件名，仅供展示。 */
	name: string;
	size: number;
	/** 上传成功的时间戳（毫秒）。 */
	uploadedAt: number;
}

interface PersistedUploadIndex {
	/** 1 = 命名空间只含 origin（旧版）；2 = origin + 路径。 */
	version: 1 | 2;
	entries: Record<string, UploadIndexEntry>;
}

export const UPLOAD_INDEX_VERSION = 2;

export interface UploadIndexLoadOptions {
	/**
	 * 是否接受 v1（只按 origin 命名空间）的旧记录。仅当当前 API URL 没有路径部分时两种键完全一致，
	 * 才能安全沿用；否则旧记录可能跨目标误命中，应丢弃（代价只是多传一次）。
	 */
	acceptLegacyV1: boolean;
}

/** 索引持久化所需的最小适配器接口（对应 Obsidian 的 DataAdapter）。 */
export interface UploadIndexStorage {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

/**
 * 上传去重索引：记录「原始字节哈希 + 目标图床 + 图片处理策略」→ 服务端 src。
 *
 * - 只保存成功上传的结果；失败不写入。
 * - 所有写盘串行化，防止并发保存互相覆盖。
 * - 已知窗口：图床已上传成功但索引尚未落盘时关闭 Obsidian，重启后该图会再传一次，
 *   只多一份远端副本，不丢数据。
 */
export class UploadIndex {
	private entries = new Map<string, UploadIndexEntry>();
	private saveChain: Promise<void> = Promise.resolve();
	private dirty = false;

	constructor(
		private storage: UploadIndexStorage,
		private filePath: string
	) {}

	async load(options: UploadIndexLoadOptions = { acceptLegacyV1: false }): Promise<void> {
		this.entries.clear();
		try {
			if (!(await this.storage.exists(this.filePath))) {
				return;
			}
			const raw = await this.storage.read(this.filePath);
			const parsed = JSON.parse(raw) as Partial<PersistedUploadIndex> | null;
			if (!parsed || typeof parsed.entries !== 'object' || parsed.entries === null
				|| (parsed.version !== 1 && parsed.version !== UPLOAD_INDEX_VERSION)) {
				console.warn('CF ImageBed: upload index has an unknown format and was ignored');
				return;
			}
			if (parsed.version === 1 && !options.acceptLegacyV1) {
				console.warn('CF ImageBed: legacy (v1) upload index cannot be mapped onto the current API path and was discarded');
				this.dirty = true;
				void this.scheduleSave();
				return;
			}
			for (const [key, entry] of Object.entries(parsed.entries)) {
				if (isValidEntry(entry)) {
					this.entries.set(key, entry);
				}
			}
			if (parsed.version === 1) {
				void this.scheduleSave(); // 升级为 v2 格式
			}
		} catch (error) {
			console.warn('CF ImageBed: failed to load upload index, starting empty', error);
		}
	}

	get size(): number {
		return this.entries.size;
	}

	get(key: string): UploadIndexEntry | undefined {
		return this.entries.get(key);
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	/** 按 src 反查（清理本地图片前用于确认该字节确实上传过）。 */
	findBySrc(src: string): { key: string; entry: UploadIndexEntry } | null {
		for (const [key, entry] of this.entries) {
			if (entry.src === src) {
				return { key, entry };
			}
		}
		return null;
	}

	set(key: string, entry: UploadIndexEntry): Promise<void> {
		this.entries.set(key, entry);
		return this.scheduleSave();
	}

	delete(key: string): Promise<void> {
		if (!this.entries.delete(key)) {
			return this.saveChain;
		}
		return this.scheduleSave();
	}

	/** 删除所有指向该 src 的记录，返回删除条数。 */
	async deleteBySrc(src: string): Promise<number> {
		let removed = 0;
		for (const [key, entry] of Array.from(this.entries)) {
			if (entry.src === src) {
				this.entries.delete(key);
				removed++;
			}
		}
		if (removed > 0) {
			await this.scheduleSave();
		}
		return removed;
	}

	clear(): Promise<void> {
		this.entries.clear();
		return this.scheduleSave();
	}

	/** 等待所有排队中的写盘完成。 */
	flush(): Promise<void> {
		return this.saveChain;
	}

	private scheduleSave(): Promise<void> {
		this.dirty = true;
		this.saveChain = this.saveChain
			.then(() => this.writeIfDirty())
			.catch((error) => {
				console.warn('CF ImageBed: failed to save upload index', error);
			});
		return this.saveChain;
	}

	private async writeIfDirty(): Promise<void> {
		if (!this.dirty) {
			return;
		}
		this.dirty = false;
		const payload: PersistedUploadIndex = {
			version: UPLOAD_INDEX_VERSION,
			entries: Object.fromEntries(this.entries)
		};
		await this.storage.write(this.filePath, JSON.stringify(payload, null, 2));
	}
}

function isValidEntry(value: unknown): value is UploadIndexEntry {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const entry = value as Record<string, unknown>;
	return typeof entry.src === 'string' && entry.src.length > 0
		&& typeof entry.name === 'string'
		&& typeof entry.size === 'number'
		&& typeof entry.uploadedAt === 'number';
}

/** 去重键 = 字节哈希 + 目标命名空间 + 处理策略指纹。 */
export function buildUploadIndexKey(contentHash: string, namespace: string, policy: string): string {
	return `${contentHash}|${namespace}|${policy}`;
}

/**
 * 目标命名空间：API 地址 + 上传渠道 + 渠道名称。换图床或换渠道后旧记录不再命中。
 * 不含任何凭证。
 */
export function buildUploadNamespace(settings: Pick<CFImageBedSettings, 'apiUrl' | 'uploadChannel' | 'channelName'>): string {
	const apiUrl = (settings.apiUrl || '').trim();
	let target = apiUrl.toLowerCase().replace(/\/+$/, '');
	try {
		// origin + 路径：同一域名下的不同部署（/imgbed-a、/imgbed-b）是不同图床，不能互相复用
		const parsed = new URL(apiUrl);
		// 主机名不区分大小写，路径区分（/A 与 /a 可能是两个部署）
		target = `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
	} catch {
		// 非标准 URL 时退回到去掉尾部斜杠的原文
	}
	return `${target}|${settings.uploadChannel}|${(settings.channelName || '').trim()}`;
}

/**
 * 处理策略指纹：凡是会改变最终上传字节的客户端/服务端处理设置都参与。
 * 改了水印文字或压缩目标后，同一张原图会重新上传，而不是复用旧链接。
 */
export function buildProcessingPolicy(settings: Pick<CFImageBedSettings,
	'enableWatermark' | 'watermarkText' | 'watermarkPosition' | 'watermarkSize' | 'watermarkOpacity'
	| 'enableClientCompress' | 'compressThreshold' | 'targetSize' | 'serverCompress' | 'uploadChannel'
>): string {
	const watermark = settings.enableWatermark
		? `wm:${settings.watermarkText}|${settings.watermarkPosition}|${settings.watermarkSize}|${settings.watermarkOpacity}`
		: 'wm:off';
	const compress = settings.enableClientCompress
		? `cmp:${settings.targetSize}|${settings.compressThreshold}`
		: 'cmp:off';
	// serverCompress 仅对 telegram 渠道生效（见 getUploadQueryParams）
	const server = settings.uploadChannel === 'telegram' && settings.serverCompress ? 'srv:on' : 'srv:off';
	return `${watermark};${compress};${server}`;
}
