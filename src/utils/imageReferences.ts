export enum ImageSyntax {
	Markdown = 'markdown',
	Wiki = 'wiki',
	Url = 'url'
}

export interface ParsedImageReference {
	source: string;
	path: string;
	altText: string;
	index: number;
	length: number;
	syntax: ImageSyntax;
	isRemote: boolean;
}

export interface ClipboardHtmlImage {
	url: string;
	altText: string;
}

// alt 文本不允许包含 ]，否则 .*? 会跨过同一行前面的 ![[wiki]] 嵌入，把两条引用合成一条并造成改写重叠。
const MARKDOWN_IMAGE_REGEX =
	/!\[([^\]]*)\]\(<([^>]+)>(?:\s+(?:"[^"]*"|'[^']*'))?\)|!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
const WIKI_IMAGE_REGEX = /!\[\[([^\]]+)\]\]/g;
const IMAGE_URL_REGEX = /https?:\/\/[^\s<>"']+/g;
const IMAGE_EXTENSION_REGEX =
	/\.(apng|avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|webp)(?:$|[?#])/i;

interface ExcludedRange {
	start: number;
	end: number;
}

/**
 * 计算不应参与图片识别的区间：围栏代码块（``` / ~~~）、行内代码、HTML 注释与
 * Obsidian 的 %% 注释。这些位置里的图片语法只是示例或被注释掉的内容，
 * 上传并改写它们会破坏笔记。
 */
export function computeExcludedRanges(content: string): ExcludedRange[] {
	const ranges: ExcludedRange[] = [];
	const lines = content.split('\n');
	let offset = 0;
	let fence: { char: string; length: number; start: number } | null = null;
	const plainSegments: ExcludedRange[] = [];
	let segmentStart = 0;

	for (const line of lines) {
		const lineStart = offset;
		offset += line.length + 1;
		const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fence) {
			if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) {
				ranges.push({ start: fence.start, end: Math.min(offset, content.length) });
				fence = null;
				segmentStart = Math.min(offset, content.length);
			}
			continue;
		}
		if (fenceMatch) {
			plainSegments.push({ start: segmentStart, end: lineStart });
			fence = { char: fenceMatch[1][0], length: fenceMatch[1].length, start: lineStart };
		}
	}

	if (fence) {
		ranges.push({ start: fence.start, end: content.length });
	} else {
		plainSegments.push({ start: segmentStart, end: content.length });
	}

	for (const segment of plainSegments) {
		collectInlineExclusions(content, segment.start, segment.end, ranges);
	}

	return ranges.sort((left, right) => left.start - right.start);
}

function collectInlineExclusions(content: string, start: number, end: number, ranges: ExcludedRange[]): void {
	let index = start;
	while (index < end) {
		const char = content[index];
		if (char === '`') {
			let runEnd = index;
			while (runEnd < end && content[runEnd] === '`') {
				runEnd++;
			}
			const runLength = runEnd - index;
			const close = findBacktickRun(content, runEnd, end, runLength);
			if (close === -1) {
				index = runEnd;
				continue;
			}
			ranges.push({ start: index, end: close + runLength });
			index = close + runLength;
			continue;
		}
		if (content.startsWith('<!--', index)) {
			const close = content.indexOf('-->', index + 4);
			const closeEnd = close === -1 || close + 3 > end ? end : close + 3;
			ranges.push({ start: index, end: closeEnd });
			index = closeEnd;
			continue;
		}
		if (content.startsWith('%%', index)) {
			const close = content.indexOf('%%', index + 2);
			const closeEnd = close === -1 || close + 2 > end ? end : close + 2;
			ranges.push({ start: index, end: closeEnd });
			index = closeEnd;
			continue;
		}
		index++;
	}
}

function findBacktickRun(content: string, from: number, end: number, length: number): number {
	let index = from;
	while (index < end) {
		if (content[index] !== '`') {
			index++;
			continue;
		}
		let runEnd = index;
		while (runEnd < end && content[runEnd] === '`') {
			runEnd++;
		}
		if (runEnd - index === length) {
			return index;
		}
		index = runEnd;
	}
	return -1;
}

function isExcluded(index: number, ranges: ExcludedRange[]): boolean {
	return ranges.some((range) => index >= range.start && index < range.end);
}

export function extractMarkdownAndWikiImageReferences(
	content: string
): ParsedImageReference[] {
	const references: ParsedImageReference[] = [];
	const excludedRanges = computeExcludedRanges(content);

	for (const match of content.matchAll(MARKDOWN_IMAGE_REGEX)) {
		const path = (match[2] ?? match[4] ?? '').trim();
		if (!path || isExcluded(match.index ?? 0, excludedRanges)) {
			continue;
		}
		const rawAltText = (match[1] ?? match[3] ?? '').trim();

		references.push({
			source: match[0],
			path,
			altText: normalizeMarkdownAltText(rawAltText),
			index: match.index ?? 0,
			length: match[0].length,
			syntax: ImageSyntax.Markdown,
			isRemote: isRemotePath(path)
		});
	}

	for (const match of content.matchAll(WIKI_IMAGE_REGEX)) {
		const wikiParts = parseWikiImageTarget((match[1] ?? '').trim());
		const path = wikiParts.path;
		if (!path || isExcluded(match.index ?? 0, excludedRanges)) {
			continue;
		}

		references.push({
			source: match[0],
			path,
			altText: wikiParts.altText,
			index: match.index ?? 0,
			length: match[0].length,
			syntax: ImageSyntax.Wiki,
			isRemote: isRemotePath(path)
		});
	}

	return dropOverlappingReferences(references.sort((left, right) => left.index - right.index));
}

/** 同一位置被两种语法同时命中时只保留最先出现的，避免替换区间重叠写坏内容。 */
function dropOverlappingReferences(references: ParsedImageReference[]): ParsedImageReference[] {
	const kept: ParsedImageReference[] = [];
	let cursor = -1;
	for (const reference of references) {
		if (reference.index < cursor) {
			continue;
		}
		kept.push(reference);
		cursor = reference.index + reference.length;
	}
	return kept;
}

export function extractPlainImageUrlReferences(content: string): ParsedImageReference[] {
	const references: ParsedImageReference[] = [];
	const trimmedContent = content.trim();
	const excludedRanges = computeExcludedRanges(content);

	for (const match of content.matchAll(IMAGE_URL_REGEX)) {
		const path = (match[0] ?? '').trim();
		if (!looksLikeImageUrl(path) || isExcluded(match.index ?? 0, excludedRanges)) {
			continue;
		}

		references.push({
			source: path,
			path,
			altText: '',
			index: match.index ?? 0,
			length: path.length,
			syntax: ImageSyntax.Url,
			isRemote: true
		});
	}

	if (references.length === 0 && /^https?:\/\/\S+$/i.test(trimmedContent)) {
		references.push({
			source: trimmedContent,
			path: trimmedContent,
			altText: '',
			index: content.indexOf(trimmedContent),
			length: trimmedContent.length,
			syntax: ImageSyntax.Url,
			isRemote: true
		});
	}

	return references;
}

export function extractClipboardHtmlImages(
	clipboardData: DataTransfer
): ClipboardHtmlImage[] {
	const html = clipboardData.getData('text/html');
	if (!html) {
		return [];
	}

	const parser = new DOMParser();
	const document = parser.parseFromString(html, 'text/html');
	const seen = new Set<string>();
	const images: ClipboardHtmlImage[] = [];

	document.querySelectorAll('img[src]').forEach((image) => {
		const src = image.getAttribute('src')?.trim() ?? '';
		if (!isRemotePath(src) || seen.has(src)) {
			return;
		}

		seen.add(src);
		images.push({
			url: src,
			altText: image.getAttribute('alt')?.trim() ?? ''
		});
	});

	return images;
}

export function isRemotePath(path: string): boolean {
	return /^https?:\/\//i.test(path.trim());
}

export function looksLikeImageUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return IMAGE_EXTENSION_REGEX.test(parsed.pathname + parsed.search);
	} catch {
		return false;
	}
}

function parseWikiImageTarget(target: string): { path: string; altText: string } {
	const segments = target.split('|').map((segment) => segment.trim());
	const path = segments[0] ?? '';

	if (segments.length <= 1) {
		return { path, altText: '' };
	}

	if (segments.length >= 3) {
		return { path, altText: segments[1] ?? '' };
	}

	const second = segments[1] ?? '';
	if (isImageSizeToken(second)) {
		return { path, altText: '' };
	}

	return { path, altText: second };
}

function normalizeMarkdownAltText(altText: string): string {
	const separatorIndex = altText.lastIndexOf('|');
	if (separatorIndex <= 0) {
		return altText;
	}

	const maybeSize = altText.slice(separatorIndex + 1).trim();
	if (!isImageSizeToken(maybeSize)) {
		return altText;
	}

	return altText.slice(0, separatorIndex).trim();
}

function isImageSizeToken(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return /^\d+%?$/.test(normalized) || /^\d+x\d+$/.test(normalized);
}
