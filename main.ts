import { MarkdownView, Plugin, getLanguage } from 'obsidian';
import { CFImageBedSettings, DEFAULT_SETTINGS } from './src/types';
import { UploadService } from './src/upload/uploadService';
import { UploadIndex } from './src/upload/uploadIndex';
import { ImageHandler } from './src/upload/imageHandler';
import { EventHandlers } from './src/events/eventHandlers';
import { CFImageBedSettingTab } from './src/settings/settingsTab';
import { I18n, resolveLanguage } from './src/utils/i18n';
import { parseDomainList } from './src/utils/domainUtils';

function apiUrlHasPath(apiUrl: string): boolean {
	try {
		const pathname = new URL((apiUrl || '').trim()).pathname.replace(/\/+$/, '');
		return pathname.length > 0;
	} catch {
		return false;
	}
}

export default class CFImageBedPlugin extends Plugin {
	settings: CFImageBedSettings;
	uploadIndex: UploadIndex;
	private uploadService: UploadService;
	private imageHandler: ImageHandler;
	private eventHandlers: EventHandlers;
	private i18n: I18n;

	async onload() {
		await this.loadSettings();

		// 初始化i18n
		this.i18n = new I18n(this.settings.language || resolveLanguage(getLanguage()));

		// 上传去重索引：存放在插件目录下，独立于 data.json，避免与设置保存互相覆盖
		this.uploadIndex = new UploadIndex(this.app.vault.adapter, `${this.manifest.dir}/upload-index.json`);
		// 旧版索引命名空间只含 origin；当前 API URL 没有路径时两者相同，可沿用，否则丢弃
		await this.uploadIndex.load({ acceptLegacyV1: !apiUrlHasPath(this.settings.apiUrl) });

		// 初始化服务
		this.uploadService = new UploadService(this.app, this.settings, this.uploadIndex);
		this.imageHandler = new ImageHandler(this.app, this.uploadService, () => this.settings, this.i18n);
		this.eventHandlers = new EventHandlers(this.imageHandler, this.i18n, () => this.settings);

		// 注册事件处理器
		this.eventHandlers.registerDragAndDropEvents(this);
		this.eventHandlers.registerPasteEvents(this);
		this.eventHandlers.registerExcalidrawEvents(this);
		this.eventHandlers.registerEditorMenuEvents(this);

		// 移动端专用命令：支持相机拍照和相册选择
		this.addCommand({
			id: 'upload-image-mobile',
			name: this.i18n.t('commands.uploadImageMobile'),
			icon: 'camera',
			callback: () => {
				this.imageHandler.selectImageForMobile();
			}
		});

		this.addCommand({
			id: 'upload-current-note-images',
			name: this.i18n.t('commands.uploadCurrentNoteImages'),
			checkCallback: (checking: boolean) => {
				const hasMarkdownView = Boolean(this.app.workspace.getActiveViewOfType(MarkdownView));
				if (!checking && hasMarkdownView) {
					void this.imageHandler.uploadCurrentNoteImages();
				}
				return hasMarkdownView;
			}
		});

		// 添加设置页面
		this.addSettingTab(new CFImageBedSettingTab(this.app, this));
	}

	onunload() {

	}



	async loadSettings() {
		const persistedSettings = await this.loadData() as Partial<CFImageBedSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, persistedSettings);
		if (!persistedSettings?.language) {
			this.settings.language = resolveLanguage(getLanguage());
		}
		this.settings.excludedImageDomains = this.normalizeExcludedImageDomains(
			this.settings.excludedImageDomains
		);
		this.i18n?.setLanguage(this.settings.language || resolveLanguage(getLanguage()));
	}

	async saveSettings() {
		this.settings.excludedImageDomains = this.normalizeExcludedImageDomains(
			this.settings.excludedImageDomains
		);
		this.i18n?.setLanguage(this.settings.language || resolveLanguage(getLanguage()));
		await this.saveData(this.settings);
	}

	private normalizeExcludedImageDomains(value: string[] | string | undefined): string[] {
		if (Array.isArray(value)) {
			return parseDomainList(value.join(','));
		}

		if (typeof value === 'string') {
			return parseDomainList(value);
		}

		return [];
	}
}
