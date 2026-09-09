import { App, Notice, getLanguage, normalizePath, requestUrl, TFile, TFolder } from 'obsidian';
import { CFImageBedSettings } from '../types';
import { ClientCompressor } from '../utils/clientCompressor';
import { ClientWatermark } from '../utils/clientWatermark';
import { buildCustomUploadFile, resolveTemplatePath } from '../utils/templateResolver';
import { I18n, resolveLanguage } from '../utils/i18n';
import { sha256Hex } from '../utils/contentHash';
import { UploadIndex, buildProcessingPolicy, buildUploadIndexKey, buildUploadNamespace } from './uploadIndex';

interface UploadRuntimeConfig {
	file: File;
	uploadNameType: string;
	uploadFolder: string;
	backupPath: string;
}

export interface UploadImageOptions {
	showErrorNotice?: boolean;
	noteFile?: TFile | null;
	/** 跳过去重索引，强制重新上传（用于单条失效重传）。 */
	bypassDedupe?: boolean;
}

export interface UploadOutcome {
	/** 按当前返回格式拼好的链接。 */
	url: string;
	/** 服务端返回的原始 src。 */
	src: string;
	/** true = 复用了索引里已上传的同一张图片，没有发起新上传。 */
	reused: boolean;
}

export class UploadService {
	private i18n = new I18n(resolveLanguage(getLanguage()));
	/** 同一去重键的并发上传合并成一次请求。 */
	private inFlight = new Map<string, Promise<UploadOutcome | null>>();

	constructor(
		private app: App,
		private settings: CFImageBedSettings,
		private uploadIndex?: UploadIndex
	) {}

	private isDevelopmentBuild(): boolean {
		const runtime = globalThis as typeof globalThis & {
			process?: {
				env?: {
					NODE_ENV?: string;
				};
			};
		};

		return runtime.process?.env?.NODE_ENV !== 'production';
	}

	private debugLog(message: string): void {
		if (this.isDevelopmentBuild()) {
			console.debug(message);
		}
	}

	private syncLanguage(): void {
		this.i18n.setLanguage(this.settings.language || resolveLanguage(getLanguage()));
	}

	async uploadImage(
		file: File,
		options: UploadImageOptions = {}
	): Promise<string | null> {
		const outcome = await this.uploadImageDetailed(file, options);
		return outcome?.url ?? null;
	}

	/**
	 * 结构化上传：区分「新上传」与「复用索引」。失败返回 null，并按 options 决定是否弹提示。
	 * 去重流程：校验 → 原始字节 SHA-256 → 查成功索引 / 合并进行中的同图请求 → 上传 → 记录索引。
	 */
	async uploadImageDetailed(
		file: File,
		options: UploadImageOptions = {}
	): Promise<UploadOutcome | null> {
		this.syncLanguage();

		if (!this.settings.apiUrl || (!this.settings.authCode && !this.settings.apiToken)) {
			if (options.showErrorNotice !== false) {
				new Notice(this.i18n.t('notices.uploadConfigRequired'));
			}
			return null;
		}

		try {
			const runtimeConfig = this.resolveUploadRuntimeConfig(file, options.noteFile ?? this.app.workspace.getActiveFile());

			// 检查文件类型
			if (!this.isAllowedFileType(runtimeConfig.file)) {
				if (options.showErrorNotice !== false) {
					new Notice(this.i18n.t('notices.unsupportedFileType', { type: runtimeConfig.file.type }));
				}
				return null;
			}

			// 检查文件大小
			if (!this.isFileSizeAllowed(runtimeConfig.file)) {
				if (options.showErrorNotice !== false) {
					new Notice(this.i18n.t('notices.fileSizeExceeded', {
						size: ClientCompressor.formatFileSize(runtimeConfig.file.size)
					}));
				}
				return null;
			}

			// 内容去重：命中索引直接复用旧链接，不再发请求
			const dedupeKey = options.bypassDedupe ? null : await this.resolveDedupeKey(runtimeConfig.file);
			// 循环：命中索引直接复用；有同图请求在途就等它；它失败后重新回到循环顶部，
			// 这样多个等待者会再次合并到「第一个重试者」的请求上，而不是各自重传。
			while (dedupeKey) {
				const cached = this.uploadIndex?.get(dedupeKey);
				if (cached) {
					this.debugLog(`CF ImageBed: reusing already uploaded image ${cached.src}`);
					this.notifyReused();
					return { url: this.buildReturnUrl(cached.src), src: cached.src, reused: true };
				}
				const inFlight = this.inFlight.get(dedupeKey);
				if (!inFlight) {
					break;
				}
				const shared = await inFlight;
				if (shared) {
					this.notifyReused();
					return { ...shared, reused: true };
				}
			}

			const task = this.performUpload(runtimeConfig, dedupeKey);
			if (dedupeKey) {
				this.inFlight.set(dedupeKey, task.catch(() => null));
			}
			try {
				return await task;
			} finally {
				if (dedupeKey) {
					this.inFlight.delete(dedupeKey);
				}
			}
		} catch (error) {
			console.error('CF ImageBed: Image upload failed:', error);
			if (options.showErrorNotice !== false && this.settings.showErrorNotification) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				new Notice(
					this.i18n.t('notices.uploadFailed', { message: errorMessage }),
					(this.settings.notificationDuration ?? 5) * 1000
				);
			}
			return null;
		}
	}

	private async performUpload(runtimeConfig: UploadRuntimeConfig, dedupeKey: string | null): Promise<UploadOutcome> {
		// 客户端处理（水印 + 压缩）
		let processedFile = runtimeConfig.file;

		// 1. 添加水印
		if (this.settings.enableWatermark && ClientWatermark.isWatermarkable(runtimeConfig.file)) {
			this.debugLog('CF ImageBed: Starting watermark addition');
			processedFile = await ClientWatermark.addWatermark(
				processedFile,
				this.settings.watermarkText,
				this.settings.watermarkPosition,
				this.settings.watermarkSize,
				this.settings.watermarkOpacity
			);
		}

		// 2. 客户端压缩
		if (this.settings.enableClientCompress && ClientCompressor.isCompressible(processedFile)) {
			this.debugLog('CF ImageBed: Starting client compression');
			processedFile = await ClientCompressor.compressImage(
				processedFile,
				this.settings.targetSize,
				this.settings.compressThreshold
			);

			// 显示压缩结果
			const originalSize = ClientCompressor.formatFileSize(runtimeConfig.file.size);
			const processedSize = ClientCompressor.formatFileSize(processedFile.size);
			this.debugLog(`CF ImageBed: Processing complete - Original: ${originalSize}, Processed: ${processedSize}`);
		}

		const result = this.shouldUseChunkedUpload(processedFile)
			? await this.chunkedUpload(processedFile, runtimeConfig)
			: await this.simpleUpload(processedFile, runtimeConfig);

		const src = this.extractSrc(result);
		if (!src) {
			throw new Error(this.i18n.t('errors.serverResponseInvalid'));
		}

		// 只记录成功结果；写盘由索引串行化。
		// 上传期间若用户改了图床/渠道/处理设置，键已不再对应本次实际发往的目标，则不记录，避免把
		// 新图床的结果写进旧图床的命名空间。
		if (dedupeKey && this.uploadIndex && dedupeKey === this.rebuildKey(dedupeKey)) {
			void this.uploadIndex.set(dedupeKey, {
				src,
				name: runtimeConfig.file.name,
				size: runtimeConfig.file.size,
				uploadedAt: Date.now()
			});
		}

		// 可选：本地备份
		if (this.settings.enableLocalBackup && runtimeConfig.backupPath.trim()) {
			try {
				await this.saveLocalBackup(processedFile, runtimeConfig.backupPath);
			} catch (e) {
				console.warn('CF ImageBed: Local backup failed:', e);
			}
		}

		return { url: this.buildReturnUrl(src), src, reused: false };
	}

	/** 根据返回格式设置把服务端 src 拼成最终链接（优先自定义前缀，否则回退到 API URL）。 */
	buildReturnUrl(src: string): string {
		// 绝对链接（returnFormat=full 时服务端直接返回完整 URL）原样返回；
		// 相对 src 无论当前返回格式如何都要拼前缀——索引里可能存着旧格式下的相对 src。
		if (/^https?:\/\//i.test(src)) {
			return src;
		}
		const baseUrl = (this.settings.customReturnBaseUrl?.trim() || this.settings.apiUrl).replace(/\/+$/, '');
		return `${baseUrl}${src.startsWith('/') ? '' : '/'}${src}`;
	}

	/** 去重键：原始字节 SHA-256 + 目标命名空间 + 处理策略；去重关闭或哈希失败时返回 null。 */
	private async resolveDedupeKey(file: File): Promise<string | null> {
		if (!this.uploadIndex || this.settings.enableUploadDedupe === false) {
			return null;
		}
		try {
			const hash = await sha256Hex(file);
			return buildUploadIndexKey(hash, buildUploadNamespace(this.settings), buildProcessingPolicy(this.settings));
		} catch (error) {
			console.warn('CF ImageBed: failed to hash image, uploading without dedupe', error);
			return null;
		}
	}

	/** 用当前设置重算同一哈希的键，用于检测上传期间设置是否变化。 */
	private rebuildKey(previousKey: string): string {
		const hash = previousKey.split('|')[0];
		return buildUploadIndexKey(hash, buildUploadNamespace(this.settings), buildProcessingPolicy(this.settings));
	}

	private notifyReused(): void {
		if (this.settings.showUploadProgress) {
			new Notice(this.i18n.t('notices.uploadReused'));
		}
	}

	private shouldUseChunkedUpload(file: File): boolean {
		if (!['telegram', 'discord'].includes(this.settings.uploadChannel)) {
			return false;
		}

		if (this.settings.chunkSizeMB <= 0) {
			return false;
		}

		const chunkSizeBytes = this.settings.chunkSizeMB * 1024 * 1024;
		return file.size > chunkSizeBytes;
	}

	private getUploadQueryParams(
		runtimeConfig: UploadRuntimeConfig,
		extraParams?: Record<string, string>
	): URLSearchParams {
		const params = new URLSearchParams({
			uploadChannel: this.settings.uploadChannel,
			uploadNameType: runtimeConfig.uploadNameType,
			returnFormat: this.settings.returnFormat,
			autoRetry: this.settings.autoRetry.toString()
		});

		if (!this.settings.apiToken && this.settings.authCode) {
			params.append('authCode', this.settings.authCode);
		}

		if (this.settings.channelName?.trim()) {
			params.append('channelName', this.settings.channelName.trim());
		}

		if (runtimeConfig.uploadFolder.trim()) {
			params.append('uploadFolder', runtimeConfig.uploadFolder.trim());
		}

		if (this.settings.uploadChannel === 'telegram') {
			params.append('serverCompress', this.settings.serverCompress.toString());
		}

		if (extraParams) {
			for (const [key, value] of Object.entries(extraParams)) {
				params.append(key, value);
			}
		}

		return params;
	}

	private getHeaders(boundary: string): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': `multipart/form-data; boundary=${boundary}`
		};

		if (this.settings.apiToken?.trim()) {
			headers.Authorization = `Bearer ${this.settings.apiToken.trim()}`;
		}

		return headers;
	}

	private async simpleUpload(file: File, runtimeConfig: UploadRuntimeConfig): Promise<unknown> {
		const params = this.getUploadQueryParams(runtimeConfig);
		return this.sendMultipartRequest(params, { file });
	}

	private async chunkedUpload(file: File, runtimeConfig: UploadRuntimeConfig): Promise<unknown> {
		if (this.settings.chunkSizeMB <= 0) {
			throw new Error(this.i18n.t('errors.chunkSizeMustBePositive'));
		}

		const chunkSizeBytes = this.settings.chunkSizeMB * 1024 * 1024;
		const totalChunks = Math.ceil(file.size / chunkSizeBytes);
		const originalFileType = file.type || 'application/octet-stream';

		const initResult = await this.sendMultipartRequest(
			this.getUploadQueryParams(runtimeConfig, { initChunked: 'true' }),
			{
				totalChunks: String(totalChunks),
				originalFileName: file.name,
				originalFileType
			}
		);

		const uploadId = this.extractUploadId(initResult);
		if (!uploadId) {
			throw new Error(this.i18n.t('errors.chunkInitMissingUploadId'));
		}

		for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
			const start = chunkIndex * chunkSizeBytes;
			const end = Math.min(file.size, start + chunkSizeBytes);
			const chunkBlob = file.slice(start, end, originalFileType);
			const chunkFile = new File([chunkBlob], file.name, { type: originalFileType });

			await this.sendMultipartRequest(
				this.getUploadQueryParams(runtimeConfig, { chunked: 'true' }),
				{
					uploadId,
					chunkIndex: String(chunkIndex),
					totalChunks: String(totalChunks),
					originalFileName: file.name,
					originalFileType,
					file: chunkFile
				}
			);
		}

		return this.sendMultipartRequest(
			this.getUploadQueryParams(runtimeConfig, { chunked: 'true', merge: 'true' }),
			{
				uploadId,
				totalChunks: String(totalChunks),
				originalFileName: file.name,
				originalFileType
			}
		);
	}

	private async sendMultipartRequest(
		params: URLSearchParams,
		fields: Record<string, string | File>
	): Promise<unknown> {
		const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
		const body = await this.buildMultipartBody(boundary, fields);
		const response = await requestUrl({
			url: `${this.settings.apiUrl}/upload?${params.toString()}`,
			method: 'POST',
			body: body.buffer,
			headers: this.getHeaders(boundary)
		});

		if (response.status !== 200) {
			throw new Error(this.i18n.t('errors.uploadHttpFailed', { status: response.status }));
		}

		return response.json;
	}

	private async buildMultipartBody(
		boundary: string,
		fields: Record<string, string | File>
	): Promise<Uint8Array> {
		const encoder = new TextEncoder();
		const parts: Uint8Array[] = [];
		let totalLength = 0;

		for (const [name, value] of Object.entries(fields)) {
			if (value instanceof File) {
				const header = encoder.encode(
					`--${boundary}\r\n` +
					`Content-Disposition: form-data; name="${name}"; filename="${value.name}"\r\n` +
					`Content-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`
				);
				const content = new Uint8Array(await value.arrayBuffer());
				const footer = encoder.encode('\r\n');

				parts.push(header, content, footer);
				totalLength += header.length + content.length + footer.length;
			} else {
				const field = encoder.encode(
					`--${boundary}\r\n` +
					`Content-Disposition: form-data; name="${name}"\r\n\r\n` +
					`${value}\r\n`
				);
				parts.push(field);
				totalLength += field.length;
			}
		}

		const ending = encoder.encode(`--${boundary}--\r\n`);
		parts.push(ending);
		totalLength += ending.length;

		const body = new Uint8Array(totalLength);
		let offset = 0;
		for (const part of parts) {
			body.set(part, offset);
			offset += part.length;
		}

		return body;
	}

	private extractSrc(result: unknown): string | null {
		if (Array.isArray(result) && result[0] && this.isRecord(result[0])) {
			const src = this.readString(result[0], 'src');
			if (src) {
				return src;
			}
		}

		if (this.isRecord(result)) {
			const src = this.readString(result, 'src');
			if (src) {
				return src;
			}

			const data = result.data;
			if (Array.isArray(data) && data[0] && this.isRecord(data[0])) {
				return this.readString(data[0], 'src');
			}
		}

		return null;
	}

	private resolveUploadRuntimeConfig(file: File, noteFile: TFile | null): UploadRuntimeConfig {
		const templateContext = {
			noteFile,
			originalFile: file
		};
		const uploadNameType = this.settings.uploadNameType === 'custom'
			? 'origin'
			: this.settings.uploadNameType;
		const renamedFile = this.settings.uploadNameType === 'custom'
			? buildCustomUploadFile(file, this.settings.customUploadNamePattern, templateContext)
			: file;

		return {
			file: renamedFile,
			uploadNameType,
			uploadFolder: resolveTemplatePath(this.settings.uploadFolder, templateContext),
			backupPath: resolveTemplatePath(this.settings.backupPath, templateContext)
		};
	}

	private extractUploadId(result: unknown): string | null {
		if (this.isRecord(result)) {
			return this.readString(result, 'uploadId');
		}

		return null;
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null;
	}

	private readString(record: Record<string, unknown>, key: string): string | null {
		const value = record[key];
		return typeof value === 'string' ? value : null;
	}

	private async saveLocalBackup(file: File, backupPath: string): Promise<void> {
		const normalized = normalizePath(backupPath);
		const arrayBuffer = await file.arrayBuffer();
		await this.ensureFolderExists(normalized);
		const targetFilePath = normalizePath(`${normalized}/${file.name}`);
		// 如果存在则覆盖
		const existing = this.app.vault.getAbstractFileByPath(targetFilePath);
		if (existing && existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, arrayBuffer);
		} else {
			await this.app.vault.createBinary(targetFilePath, arrayBuffer);
		}
	}

	private async ensureFolderExists(folderPath: string): Promise<void> {
		const normalizedFolderPath = normalizePath(folderPath).replace(/^\/+|\/+$/g, '');
		if (!normalizedFolderPath) {
			return;
		}

		let currentPath = '';
		for (const segment of normalizedFolderPath.split('/')) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);

			if (!existing) {
				await this.app.vault.createFolder(currentPath);
				continue;
			}

			if (!(existing instanceof TFolder)) {
				throw new Error(this.i18n.t('errors.backupPathConflict', { path: currentPath }));
			}
		}
	}

	/**
	 * 检查文件类型是否允许
	 */
	private isAllowedFileType(file: File): boolean {
		const extension = file.name.split('.').pop()?.toLowerCase();
		return extension ? this.settings.allowedFileTypes.includes(extension) : false;
	}

	/**
	 * 检查文件大小是否允许
	 */
	private isFileSizeAllowed(file: File): boolean {
		const maxSizeBytes = this.settings.maxFileSize * 1024 * 1024;
		return file.size <= maxSizeBytes;
	}
}
