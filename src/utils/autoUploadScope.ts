import type { CFImageBedSettings } from '../types';

export interface AutoUploadScope {
	wholeVault: boolean;
	folders: string[];
}

/** 解析监听范围：未配置文件夹且未开启「整个库」时返回 null（= 不监听）。 */
export function resolveAutoUploadScope(settings: Pick<CFImageBedSettings, 'autoUploadFolders' | 'autoUploadWholeVault'>): AutoUploadScope | null {
	if (settings.autoUploadWholeVault) {
		return { wholeVault: true, folders: [] };
	}
	const folders = (settings.autoUploadFolders || '')
		.split(',')
		.map((folder) => folder.trim().replace(/^\/+|\/+$/g, ''))
		.filter((folder) => folder.length > 0);
	return folders.length > 0 ? { wholeVault: false, folders } : null;
}

export function isPathInScope(path: string, scope: AutoUploadScope): boolean {
	if (scope.wholeVault) {
		return true;
	}
	return scope.folders.some((folder) => path === folder || path.startsWith(folder + '/'));
}

/** 自动上云是否会处理这篇笔记（开关已开且路径在范围内）。 */
export function isAutoUploadActiveFor(
	settings: Pick<CFImageBedSettings, 'enableAutoUpload' | 'autoUploadFolders' | 'autoUploadWholeVault'>,
	notePath: string
): boolean {
	if (!settings.enableAutoUpload) {
		return false;
	}
	const scope = resolveAutoUploadScope(settings);
	return scope !== null && isPathInScope(notePath, scope);
}
