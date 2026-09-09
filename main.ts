import { MarkdownView, Notice, Plugin, getLanguage } from 'obsidian';
import { CFImageBedSettings, DEFAULT_SETTINGS } from './src/types';
import { UploadService } from './src/upload/uploadService';
import { UploadIndex } from './src/upload/uploadIndex';
import { LocalImageCleaner } from './src/upload/localImageCleaner';
import { ConfirmModal } from './src/ui/confirmModal';
import { ImageHandler } from './src/upload/imageHandler';
import { EventHandlers } from './src/events/eventHandlers';
import { AutoUploadWatcher } from './src/events/autoUploadWatcher';
import { CFImageBedSettingTab } from './src/settings/settingsTab';
import { I18n, resolveLanguage } from './src/utils/i18n';
import { parseDomainList } from './src/utils/domainUtils';

export default class CFImageBedPlugin extends Plugin {
	settings: CFImageBedSettings;
	uploadIndex: UploadIndex;
	private localImageCleaner: LocalImageCleaner;
	private uploadService: UploadService;
	private imageHandler: ImageHandler;
	private eventHandlers: EventHandlers;
	private autoUploadWatcher: AutoUploadWatcher;
	private i18n: I18n;

	async onload() {
		await this.loadSettings();

		// 初始化i18n
		this.i18n = new I18n(this.settings.language || resolveLanguage(getLanguage()));

		// 上传去重索引：存放在插件目录下，独立于 data.json，避免与设置保存互相覆盖
		this.uploadIndex = new UploadIndex(this.app.vault.adapter, `${this.manifest.dir}/upload-index.json`);
		await this.uploadIndex.load();

		// 初始化服务
		this.uploadService = new UploadService(this.app, this.settings, this.uploadIndex);
		// 上传后删除本地图片：只有链接写回、索引核对、全库引用、远端验证全部通过才进回收站
		this.localImageCleaner = new LocalImageCleaner(
			this.app,
			this.uploadIndex,
			() => this.settings,
			(src) => this.uploadService.buildReturnUrl(src),
			this.i18n
		);
		this.imageHandler = new ImageHandler(this.app, this.uploadService, () => this.settings, this.i18n, this.localImageCleaner);
		this.eventHandlers = new EventHandlers(this.imageHandler, this.i18n, () => this.settings);

		// 注册事件处理器
		this.eventHandlers.registerDragAndDropEvents(this);
		this.eventHandlers.registerPasteEvents(this);
		this.eventHandlers.registerExcalidrawEvents(this);
		this.eventHandlers.registerEditorMenuEvents(this);

		// 图片自动上云监听器：监听笔记改动，把图片转存到图床并改写链接。
		// 在 onLayoutReady 之后再注册（避免启动时的全库 create 事件风暴），随后对监听范围补扫一次。
		this.autoUploadWatcher = new AutoUploadWatcher(this, this.imageHandler, () => this.settings, this.i18n, this.localImageCleaner);
		this.app.workspace.onLayoutReady(() => this.autoUploadWatcher.register());

		// 手动：找出已上云（字节命中索引）且全库无引用的孤立图片，预览确认后逐张复核并移到回收站
		this.addCommand({
			id: 'cleanup-orphan-images',
			name: this.i18n.t('commands.cleanupOrphanImages'),
			callback: () => {
				void this.cleanupOrphanImages();
			}
		});

		// 手动：扫描监听范围（未配置时为整个库）内的现有笔记，确认后批量迁移图片
		this.addCommand({
			id: 'scan-and-migrate-images',
			name: this.i18n.t('commands.scanAndMigrateImages'),
			callback: () => {
				void this.autoUploadWatcher.scanAndMigrate();
			}
		});

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
		// 取消所有待处理任务；已在途的上传结果不再写回文件，在途的清理不再删除文件
		this.autoUploadWatcher?.unload();
		this.localImageCleaner?.dispose();
	}

	private async cleanupOrphanImages(): Promise<void> {
		new Notice(this.i18n.t('cleanup.orphanScanning'));
		const orphans = await this.localImageCleaner.findOrphans();
		if (orphans.length === 0) {
			new Notice(this.i18n.t('cleanup.orphanNone'));
			return;
		}
		const preview = orphans.slice(0, 8).map((item) => `• ${item.file.path}`).join('\n')
			+ (orphans.length > 8 ? `\n…` : '');
		new ConfirmModal(this.app, {
			title: this.i18n.t('cleanup.orphanConfirmTitle'),
			message: this.i18n.t('cleanup.orphanConfirmMessage', { count: orphans.length, preview }),
			confirmText: this.i18n.t('cleanup.confirm'),
			cancelText: this.i18n.t('cleanup.cancel'),
			onConfirm: () => {
				void this.localImageCleaner.cleanupOrphans(orphans);
			}
		}).open();
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
