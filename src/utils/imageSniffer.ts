/**
 * 按文件头（magic bytes）识别真实图片类型，返回 MIME；不是图片则返回 null。
 * 用于网络图片转存：响应头和 URL 扩展名都不可信（登录页 / 管理页 / 错误页同样返回 200）。
 */
export function sniffImageMimeType(data: ArrayBuffer): string | null {
	const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, 1024));
	if (bytes.length < 4) {
		return null;
	}

	const startsWith = (signature: number[], offset = 0): boolean =>
		signature.every((value, index) => bytes[offset + index] === value);
	const ascii = (start: number, end: number): string =>
		String.fromCharCode(...Array.from(bytes.slice(start, end)));

	if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return 'image/png';
	}
	if (startsWith([0xff, 0xd8, 0xff])) {
		return 'image/jpeg';
	}
	if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
		return 'image/gif';
	}
	if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
		return 'image/webp';
	}
	if (ascii(0, 2) === 'BM') {
		return 'image/bmp';
	}
	if (startsWith([0x00, 0x00, 0x01, 0x00])) {
		return 'image/x-icon';
	}
	if (startsWith([0x49, 0x49, 0x2a, 0x00]) || startsWith([0x4d, 0x4d, 0x00, 0x2a])) {
		return 'image/tiff';
	}
	if (ascii(4, 8) === 'ftyp') {
		const brand = ascii(8, 12);
		if (brand === 'avif' || brand === 'avis') {
			return 'image/avif';
		}
		if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) {
			return 'image/heic';
		}
		if (brand === 'mif1' || brand === 'msf1') {
			return 'image/heif';
		}
		return null;
	}

	return looksLikeSvg(bytes) ? 'image/svg+xml' : null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
	let head: string;
	try {
		head = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	} catch {
		return false;
	}
	const text = head.replace(/^﻿/, '').trimStart().toLowerCase();
	if (text.startsWith('<svg')) {
		return true;
	}
	// 带 XML 声明 / 注释 / DOCTYPE 前缀的 SVG；内嵌 <svg> 的 HTML 页面不算
	if (!/^<(\?xml|!--|!doctype\s+svg)/.test(text) || /<(html|body|head)[\s>]/.test(text)) {
		return false;
	}
	return /<svg[\s>]/.test(text);
}
