export interface Slot {
  id: string;
  time: string; // "19:30", venue local time
  covers: number;
}

export async function fetchSlots(api: string, venue: string, dateKey: string, party: number): Promise<Slot[]> {
  const url = `${api}/venues/${encodeURIComponent(venue)}/availability?date=${dateKey}&party=${party}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const body = (await res.json()) as { slots: Slot[] };
  return body.slots.filter((s) => s.covers >= party);
}
