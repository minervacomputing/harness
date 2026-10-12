// Python's `ipaddress.ip_address(text)` as a test: which address family the text is, or null where it
// raises ValueError (a host name). Mail domains that are IP addresses are refused (sites.ts), a link
// whose bracketed host is not an IPv6 address is dropped (gmail's html.ts), and `urlsplit` refuses brackets
// around anything else (Microsoft's nextLink reading).

/** `ipaddress.IPv4Address(text)` does not raise. */
export function isIpv4(text: string): boolean {
	if (!text || text.includes("/")) return false;
	const octets = text.split(".");
	if (octets.length !== 4) return false;
	return octets.every((octet) => /^[0-9]{1,3}$/.test(octet) && (octet === "0" || octet[0] !== "0") && Number(octet) <= 255);
}

const HEXTET = /^[0-9a-fA-F]{1,4}$/;

/** `ipaddress.IPv6Address(text)` does not raise, scope ids included. */
export function isIpv6(text: string): boolean {
	if (text.includes("/")) return false;
	// _split_scope_id: a scope after "%" must be there and hold no other "%".
	let address = text;
	const percent = text.indexOf("%");
	if (percent >= 0) {
		const scope = text.slice(percent + 1);
		if (!scope || scope.includes("%")) return false;
		address = text.slice(0, percent);
	}
	if (!address || address.length > 45) return false;
	// At most 9 parts are split off; the rest stays in the last one, as `split(":", maxsplit=9)`.
	const all = address.split(":");
	const parts = all.length > 10 ? [...all.slice(0, 9), all.slice(9).join(":")] : all;
	if (parts.length < 3) return false;
	const last = parts[parts.length - 1] as string;
	if (last.includes(".")) {
		if (!isIpv4(last)) return false;
		parts.pop();
		parts.push("0", "0");
	}
	if (parts.length > 9) return false;
	let skip: number | null = null;
	for (let i = 1; i < parts.length - 1; i++) {
		if (parts[i]) continue;
		if (skip !== null) return false;
		skip = i;
	}
	let hi: number;
	let lo: number;
	if (skip !== null) {
		hi = skip;
		lo = parts.length - skip - 1;
		if (!parts[0]) {
			hi -= 1;
			if (hi) return false;
		}
		if (!parts[parts.length - 1]) {
			lo -= 1;
			if (lo) return false;
		}
		if (8 - (hi + lo) < 1) return false;
	} else {
		if (parts.length !== 8 || !parts[0] || !parts[parts.length - 1]) return false;
		hi = parts.length;
		lo = 0;
	}
	const used = [...parts.slice(0, hi), ...(lo ? parts.slice(-lo) : [])];
	return used.every((part) => HEXTET.test(part));
}

/** "v4", "v6", or null when `ipaddress.ip_address(text)` raises. */
export function isIpAddress(text: string): "v4" | "v6" | null {
	if (isIpv4(text)) return "v4";
	if (isIpv6(text)) return "v6";
	return null;
}
