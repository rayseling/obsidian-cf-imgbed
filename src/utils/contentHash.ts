/**
 * 计算文件原始字节的 SHA-256（十六进制）。用于上传去重：
 * 「相同图片」以字节完全相同为准，不做视觉相似判断。
 */
export async function sha256Hex(data: ArrayBuffer | Uint8Array | Blob): Promise<string> {
	const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
	const digest = await crypto.subtle.digest('SHA-256', buffer);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}
