// Which address family a text is as Python's `ipaddress.ip_address(text)` reads it, or null where that
// raises ValueError (a host name). ipaddr.js (MIT) parses; the rules it reads differently are kept here, so a
// text is an address exactly where it was:
//
// - IPv4 is four decimal octets without leading zeros (`127.1`, `0x7f.1` and `0177.0.0.1` are not addresses
//   here: sites.ts refuses them as host names with numeric last labels);
// - an IPv6 scope after "%" may hold anything but "%" and "/", where ipaddr.js takes letters and digits;
// - an IPv4 tail inside IPv6 follows the IPv4 rule;
// - no "/" anywhere.
//
// It tells what a text is; it decides nothing about where a request may go. Mail domains and site names
// that are IP addresses are refused (sites.ts), and `urlsplit` refuses brackets around anything else. Which
// addresses a fetch reaches is the platform's decision (connectors/web/fetch.ts).

import ipaddr from "ipaddr.js";

/** `ipaddress.IPv4Address(text)` does not raise. */
function isIpv4(text: string): boolean {
	return ipaddr.IPv4.isValidFourPartDecimal(text);
}

/** `ipaddress.IPv6Address(text)` does not raise, scope ids included. */
function isIpv6(text: string): boolean {
	if (text.includes("/")) return false;
	let address = text;
	const percent = text.indexOf("%");
	if (percent >= 0) {
		const scope = text.slice(percent + 1);
		if (!scope || scope.includes("%")) return false;
		address = text.slice(0, percent);
	}
	const tail = address.slice(address.lastIndexOf(":") + 1);
	if (tail.includes(".") && !isIpv4(tail)) return false;
	return ipaddr.IPv6.isValid(address);
}

/** "v4", "v6", or null when `ipaddress.ip_address(text)` raises. */
export function isIpAddress(text: string): "v4" | "v6" | null {
	if (isIpv4(text)) return "v4";
	if (isIpv6(text)) return "v6";
	return null;
}
