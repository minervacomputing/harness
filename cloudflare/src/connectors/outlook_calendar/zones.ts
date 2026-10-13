// The IANA names Graph documents as accepted besides Windows names (dateTimeTimeZone, "Additional time
// zones"), and UTC.

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
