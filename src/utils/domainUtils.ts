export function getEffectiveExcludedDomains(
	apiUrl: string,
	configuredDomains: string[],
	customReturnBaseUrl = ''
): string[] {
	const domains = [...configuredDomains];

	// API 域名与自定义返回链接域名都是「自己的图床」，其图片不应再次转存。
	for (const hostname of getOwnImageBedHostnames(apiUrl, customReturnBaseUrl)) {
		domains.push(hostname);
	}

	return uniqueNormalizedDomains(domains);
}

/** 返回当前图床自身的域名（API URL + 自定义返回链接前缀），去重后按顺序给出。 */
export function getOwnImageBedHostnames(apiUrl: string, customReturnBaseUrl = ''): string[] {
	const hostnames: string[] = [];
	for (const candidate of [apiUrl, customReturnBaseUrl]) {
		const hostname = extractHostname(candidate ?? '');
		if (hostname && !hostnames.includes(hostname)) {
			hostnames.push(hostname);
		}
	}
	return hostnames;
}

export function parseDomainList(value: string): string[] {
	return uniqueNormalizedDomains(value.split(/[\n,]/g));
}

export function formatDomainList(domains: string[]): string {
	return uniqueNormalizedDomains(domains).join(', ');
}

export function isUrlExcluded(url: string, domains: string[]): boolean {
	const hostname = extractHostname(url);
	if (!hostname) {
		return false;
	}

	return domains.some((domain) => {
		return hostname === domain || hostname.endsWith(`.${domain}`);
	});
}

export function extractHostname(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	try {
		return new URL(trimmed).hostname.toLowerCase();
	} catch {
		try {
			return new URL(`https://${trimmed}`).hostname.toLowerCase();
		} catch {
			return null;
		}
	}
}

function uniqueNormalizedDomains(domains: string[]): string[] {
	const uniqueDomains = new Set<string>();

	for (const domain of domains) {
		const normalizedDomain = normalizeDomain(domain);
		if (normalizedDomain) {
			uniqueDomains.add(normalizedDomain);
		}
	}

	return Array.from(uniqueDomains);
}

function normalizeDomain(domain: string): string | null {
	const hostname = extractHostname(domain);
	if (hostname) {
		return hostname;
	}

	const trimmed = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
	return trimmed || null;
}
