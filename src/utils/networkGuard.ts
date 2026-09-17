/**
 * 网络图片转存的目标地址分类。URL 来自笔记内容（Web Clipper、AI 工具、共享库都可能写入），
 * 不加限制等于让笔记内容驱动插件去请求本机 / 内网服务（路由器、摄像头快照、管理后台），
 * 并把拿到的图片转存到图床。
 *
 * 局限：只按 URL 里的主机名判断。requestUrl 不暴露 DNS 解析结果和重定向链，
 * 指向内网 IP 的公网域名、或公网地址 302 到内网，这里拦不住。
 */
export type RemoteHostKind = 'public' | 'private' | 'invalid';

export function classifyRemoteHost(url: string): RemoteHostKind {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return 'invalid';
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return 'invalid';
	}

	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
	if (!host) {
		return 'invalid';
	}
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
		|| host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) {
		return 'private';
	}
	// 公共通配 DNS：127.0.0.1.nip.io 这类域名按名字里的 IP 解析，是绕过主机名检查的现成工具
	if (WILDCARD_DNS_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
		return 'private';
	}
	if (host.includes(':')) {
		return isPrivateIpv6(host) ? 'private' : 'public';
	}

	const ipv4 = parseIpv4(host);
	if (ipv4) {
		return isPrivateIpv4(ipv4) ? 'private' : 'public';
	}
	// 没有点的裸主机名（http://nas/、http://router/）只可能解析到内网
	return host.includes('.') ? 'public' : 'private';
}

const WILDCARD_DNS_SUFFIXES = ['nip.io', 'sslip.io', 'xip.io', 'traefik.me', 'localtest.me', 'lvh.me', 'vcap.me'];

/** 支持 WHATWG URL 已归一化的点分十进制；URL 解析器会把 0x7f.1、2130706433 这类写法归一成 127.0.0.1。 */
function parseIpv4(host: string): number[] | null {
	const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!match) {
		return null;
	}
	const octets = match.slice(1).map(Number);
	return octets.every((octet) => octet <= 255) ? octets : null;
}

function isPrivateIpv4([a, b]: number[]): boolean {
	return a === 0 // 0.0.0.0/8
		|| a === 10
		|| a === 127 // 环回
		|| (a === 100 && b >= 64 && b <= 127) // CGNAT
		|| (a === 169 && b === 254) // 链路本地（含云元数据 169.254.169.254）
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 168)
		|| a >= 224; // 组播 / 保留
}

function isPrivateIpv6(host: string): boolean {
	if (host === '::' || host === '::1') {
		return true;
	}
	// 已弃用的 IPv4 兼容地址 ::a.b.c.d（URL 解析器归一成 ::hhhh:hhhh）：部分系统仍会映射到 IPv4
	const compatible = host.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (compatible) {
		const high = parseInt(compatible[1], 16);
		const low = parseInt(compatible[2], 16);
		return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
	}
	// IPv4 映射地址 ::ffff:a.b.c.d / ::ffff:hhhh:hhhh
	const mapped = host.match(/^::ffff:(.+)$/);
	if (mapped) {
		const dotted = parseIpv4(mapped[1]);
		if (dotted) {
			return isPrivateIpv4(dotted);
		}
		const hex = mapped[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (hex) {
			const high = parseInt(hex[1], 16);
			const low = parseInt(hex[2], 16);
			return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
		}
		return true;
	}
	const first = parseInt(host.split(':')[0] || '0', 16);
	return (first & 0xfe00) === 0xfc00 // fc00::/7 唯一本地
		|| (first & 0xffc0) === 0xfe80; // fe80::/10 链路本地
}
