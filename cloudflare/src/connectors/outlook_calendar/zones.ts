// The time zones Graph takes (dateTimeTimeZone): Windows names, and the IANA names it documents besides them
// ("Additional time zones"), with UTC. An IANA zone it does not list is sent as the Windows zone whose
// offsets it keeps at the event's midnights and over the start's year.

import { isTimeZone } from "../../lib/dates.ts";

export const DOCUMENTED_ZONES: readonly string[] = `
Etc/GMT+12 Etc/GMT+11 Pacific/Honolulu America/Anchorage America/Santa_Isabel America/Los_Angeles
America/Phoenix America/Chihuahua America/Denver America/Guatemala America/Chicago America/Mexico_City
America/Regina America/Bogota America/New_York America/Indiana/Indianapolis America/Caracas
America/Asuncion America/Halifax America/Cuiaba America/La_Paz America/Santiago America/St_Johns
America/Sao_Paulo America/Argentina/Buenos_Aires America/Cayenne America/Godthab America/Montevideo
America/Bahia Etc/GMT+2 Atlantic/Azores Atlantic/Cape_Verde Africa/Casablanca Etc/GMT Europe/London
Atlantic/Reykjavik Europe/Berlin Europe/Budapest Europe/Paris Europe/Warsaw Africa/Lagos Africa/Windhoek
Europe/Bucharest Asia/Beirut Africa/Cairo Asia/Damascus Africa/Johannesburg Europe/Kyiv Europe/Istanbul
Asia/Jerusalem Asia/Amman Asia/Baghdad Europe/Kaliningrad Asia/Riyadh Africa/Nairobi Asia/Tehran
Asia/Dubai Asia/Baku Europe/Moscow Indian/Mauritius Asia/Tbilisi Asia/Yerevan Asia/Kabul Asia/Karachi
Asia/Kolkata Asia/Colombo Asia/Kathmandu Asia/Dhaka Asia/Yekaterinburg Asia/Bangkok Asia/Novosibirsk
Asia/Shanghai Asia/Krasnoyarsk Asia/Singapore Australia/Perth Asia/Taipei Asia/Ulaanbaatar Asia/Irkutsk
Asia/Tokyo Asia/Seoul Australia/Adelaide Australia/Darwin Australia/Brisbane Australia/Sydney
Pacific/Port_Moresby Australia/Hobart Asia/Yakutsk Pacific/Guadalcanal Asia/Vladivostok Pacific/Auckland
Etc/GMT-12 Pacific/Fiji Asia/Magadan Pacific/Tongatapu Pacific/Apia Pacific/Kiritimati
`
	.split(/\s+/)
	.filter(Boolean);

export const ZONES: ReadonlySet<string> = new Set(["UTC", ...DOCUMENTED_ZONES]);

/**
 * Every Windows time zone, with the IANA zone CLDR gives for it everywhere (windowsZones.xml, territory 001), in
 * CLDR's order.
 */
export const WINDOWS_ZONES: readonly (readonly [string, string])[] = [
	["Dateline Standard Time", "Etc/GMT+12"],
	["UTC-11", "Etc/GMT+11"],
	["Aleutian Standard Time", "America/Adak"],
	["Hawaiian Standard Time", "Pacific/Honolulu"],
	["Marquesas Standard Time", "Pacific/Marquesas"],
	["Alaskan Standard Time", "America/Anchorage"],
	["UTC-09", "Etc/GMT+9"],
	["Pacific Standard Time (Mexico)", "America/Tijuana"],
	["UTC-08", "Etc/GMT+8"],
	["Pacific Standard Time", "America/Los_Angeles"],
	["US Mountain Standard Time", "America/Phoenix"],
	["Mountain Standard Time (Mexico)", "America/Mazatlan"],
	["Mountain Standard Time", "America/Denver"],
	["British Columbia Standard Time", "America/Vancouver"],
	["Yukon Standard Time", "America/Whitehorse"],
	["Alberta Standard Time", "America/Edmonton"],
	["Central America Standard Time", "America/Guatemala"],
	["Central Standard Time", "America/Chicago"],
	["Easter Island Standard Time", "Pacific/Easter"],
	["Central Standard Time (Mexico)", "America/Mexico_City"],
	["Canada Central Standard Time", "America/Regina"],
	["Manitoba Standard Time", "America/Winnipeg"],
	["SA Pacific Standard Time", "America/Bogota"],
	["Eastern Standard Time (Mexico)", "America/Cancun"],
	["Eastern Standard Time", "America/New_York"],
	["Haiti Standard Time", "America/Port-au-Prince"],
	["Cuba Standard Time", "America/Havana"],
	["US Eastern Standard Time", "America/Indianapolis"],
	["Turks And Caicos Standard Time", "America/Grand_Turk"],
	["Paraguay Standard Time", "America/Asuncion"],
	["Atlantic Standard Time", "America/Halifax"],
	["Venezuela Standard Time", "America/Caracas"],
	["Central Brazilian Standard Time", "America/Cuiaba"],
	["SA Western Standard Time", "America/La_Paz"],
	["Pacific SA Standard Time", "America/Santiago"],
	["Newfoundland Standard Time", "America/St_Johns"],
	["Tocantins Standard Time", "America/Araguaina"],
	["E. South America Standard Time", "America/Sao_Paulo"],
	["SA Eastern Standard Time", "America/Cayenne"],
	["Argentina Standard Time", "America/Buenos_Aires"],
	["Greenland Standard Time", "America/Godthab"],
	["Montevideo Standard Time", "America/Montevideo"],
	["Magallanes Standard Time", "America/Punta_Arenas"],
	["Saint Pierre Standard Time", "America/Miquelon"],
	["Bahia Standard Time", "America/Bahia"],
	["UTC-02", "Etc/GMT+2"],
	["Azores Standard Time", "Atlantic/Azores"],
	["Cape Verde Standard Time", "Atlantic/Cape_Verde"],
	["UTC", "Etc/UTC"],
	["GMT Standard Time", "Europe/London"],
	["Greenwich Standard Time", "Atlantic/Reykjavik"],
	["Sao Tome Standard Time", "Africa/Sao_Tome"],
	["Morocco Standard Time", "Africa/Casablanca"],
	["W. Europe Standard Time", "Europe/Berlin"],
	["Central Europe Standard Time", "Europe/Budapest"],
	["Romance Standard Time", "Europe/Paris"],
	["Central European Standard Time", "Europe/Warsaw"],
	["W. Central Africa Standard Time", "Africa/Lagos"],
	["Jordan Standard Time", "Asia/Amman"],
	["GTB Standard Time", "Europe/Bucharest"],
	["Middle East Standard Time", "Asia/Beirut"],
	["Egypt Standard Time", "Africa/Cairo"],
	["E. Europe Standard Time", "Europe/Chisinau"],
	["Syria Standard Time", "Asia/Damascus"],
	["West Bank Standard Time", "Asia/Hebron"],
	["South Africa Standard Time", "Africa/Johannesburg"],
	["FLE Standard Time", "Europe/Kiev"],
	["Israel Standard Time", "Asia/Jerusalem"],
	["South Sudan Standard Time", "Africa/Juba"],
	["Kaliningrad Standard Time", "Europe/Kaliningrad"],
	["Sudan Standard Time", "Africa/Khartoum"],
	["Libya Standard Time", "Africa/Tripoli"],
	["Namibia Standard Time", "Africa/Windhoek"],
	["Arabic Standard Time", "Asia/Baghdad"],
	["Turkey Standard Time", "Europe/Istanbul"],
	["Arab Standard Time", "Asia/Riyadh"],
	["Belarus Standard Time", "Europe/Minsk"],
	["Russian Standard Time", "Europe/Moscow"],
	["E. Africa Standard Time", "Africa/Nairobi"],
	["Iran Standard Time", "Asia/Tehran"],
	["Arabian Standard Time", "Asia/Dubai"],
	["Astrakhan Standard Time", "Europe/Astrakhan"],
	["Azerbaijan Standard Time", "Asia/Baku"],
	["Russia Time Zone 3", "Europe/Samara"],
	["Mauritius Standard Time", "Indian/Mauritius"],
	["Saratov Standard Time", "Europe/Saratov"],
	["Georgian Standard Time", "Asia/Tbilisi"],
	["Volgograd Standard Time", "Europe/Volgograd"],
	["Caucasus Standard Time", "Asia/Yerevan"],
	["Afghanistan Standard Time", "Asia/Kabul"],
	["West Asia Standard Time", "Asia/Tashkent"],
	["Ekaterinburg Standard Time", "Asia/Yekaterinburg"],
	["Pakistan Standard Time", "Asia/Karachi"],
	["Qyzylorda Standard Time", "Asia/Qyzylorda"],
	["India Standard Time", "Asia/Calcutta"],
	["Sri Lanka Standard Time", "Asia/Colombo"],
	["Nepal Standard Time", "Asia/Katmandu"],
	["Central Asia Standard Time", "Asia/Bishkek"],
	["Bangladesh Standard Time", "Asia/Dhaka"],
	["Omsk Standard Time", "Asia/Omsk"],
	["Myanmar Standard Time", "Asia/Rangoon"],
	["SE Asia Standard Time", "Asia/Bangkok"],
	["Altai Standard Time", "Asia/Barnaul"],
	["W. Mongolia Standard Time", "Asia/Hovd"],
	["North Asia Standard Time", "Asia/Krasnoyarsk"],
	["N. Central Asia Standard Time", "Asia/Novosibirsk"],
	["Tomsk Standard Time", "Asia/Tomsk"],
	["China Standard Time", "Asia/Shanghai"],
	["North Asia East Standard Time", "Asia/Irkutsk"],
	["Singapore Standard Time", "Asia/Singapore"],
	["W. Australia Standard Time", "Australia/Perth"],
	["Taipei Standard Time", "Asia/Taipei"],
	["Ulaanbaatar Standard Time", "Asia/Ulaanbaatar"],
	["Aus Central W. Standard Time", "Australia/Eucla"],
	["Transbaikal Standard Time", "Asia/Chita"],
	["Tokyo Standard Time", "Asia/Tokyo"],
	["North Korea Standard Time", "Asia/Pyongyang"],
	["Korea Standard Time", "Asia/Seoul"],
	["Yakutsk Standard Time", "Asia/Yakutsk"],
	["Cen. Australia Standard Time", "Australia/Adelaide"],
	["AUS Central Standard Time", "Australia/Darwin"],
	["E. Australia Standard Time", "Australia/Brisbane"],
	["AUS Eastern Standard Time", "Australia/Sydney"],
	["West Pacific Standard Time", "Pacific/Port_Moresby"],
	["Tasmania Standard Time", "Australia/Hobart"],
	["Vladivostok Standard Time", "Asia/Vladivostok"],
	["Lord Howe Standard Time", "Australia/Lord_Howe"],
	["Bougainville Standard Time", "Pacific/Bougainville"],
	["Russia Time Zone 10", "Asia/Srednekolymsk"],
	["Magadan Standard Time", "Asia/Magadan"],
	["Norfolk Standard Time", "Pacific/Norfolk"],
	["Sakhalin Standard Time", "Asia/Sakhalin"],
	["Central Pacific Standard Time", "Pacific/Guadalcanal"],
	["Russia Time Zone 11", "Asia/Kamchatka"],
	["New Zealand Standard Time", "Pacific/Auckland"],
	["UTC+12", "Etc/GMT-12"],
	["Fiji Standard Time", "Pacific/Fiji"],
	["Chatham Islands Standard Time", "Pacific/Chatham"],
	["UTC+13", "Etc/GMT-13"],
	["Tonga Standard Time", "Pacific/Tongatapu"],
	["Samoa Standard Time", "Pacific/Apia"],
	["Line Islands Standard Time", "Pacific/Kiritimati"],
];

const WINDOWS_BY_NAME: ReadonlyMap<string, string> = new Map(WINDOWS_ZONES.map(([name]) => [name.toLowerCase(), name]));
const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at `ms`, in milliseconds. */
function offsetAt(zone: string, ms: number): number {
	let format = formats.get(zone);
	if (format === undefined) {
		format = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
		formats.set(zone, format);
	}
	// "GMT" at UTC, else "GMT+01:00".
	const name = format.formatToParts(ms).find((part) => part.type === "timeZoneName")?.value ?? "";
	const found = /^GMT([+-])(\d\d):(\d\d)$/.exec(name);
	if (found === null) return 0;
	return (found[1] === "-" ? -1 : 1) * (Number(found[2]) * 60 + Number(found[3])) * 60_000;
}

/** When the day `date` (YYYY-MM-DD) begins in the zone. */
function midnight(zone: string, date: string): number {
	const wall = Date.parse(`${date}T00:00:00Z`);
	return wall - offsetAt(zone, wall - offsetAt(zone, wall));
}

/** Whether the zone is one Graph takes, or an IANA zone that may have a Windows zone to stand for it. */
export function knownZone(zone: string): boolean {
	return ZONES.has(zone) || WINDOWS_BY_NAME.has(zone.toLowerCase()) || isTimeZone(zone);
}

/**
 * The zone Graph is sent for an all-day event in `zone` from the day `start` to the day `end` (YYYY-MM-DD): the zone
 * itself when Graph lists it, a Windows name as Windows spells it, else the first Windows zone whose IANA zone has
 * the same offset at both midnights and every day of the start's year, which stands for the zone in Outlook; null
 * when none does. One year keeps the work bounded however long the event is.
 */
export function graphZone(zone: string, start: string, end: string): string | null {
	if (ZONES.has(zone)) return zone;
	const windows = WINDOWS_BY_NAME.get(zone.toLowerCase());
	if (windows !== undefined) return windows;
	if (!isTimeZone(zone)) return null;
	const year = Number(start.slice(0, 4));
	const instants = [midnight(zone, start), midnight(zone, end)];
	for (let ms = Date.UTC(year, 0, 1, 12); ms < Date.UTC(year + 1, 0, 1); ms += DAY_MS) instants.push(ms);
	const offsets = instants.map((ms) => offsetAt(zone, ms));
	const found = WINDOWS_ZONES.find(([, iana]) => instants.every((ms, index) => offsetAt(iana, ms) === offsets[index]));
	return found === undefined ? null : found[0];
}
