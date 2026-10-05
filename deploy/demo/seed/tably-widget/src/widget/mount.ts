import { renderBookingForm } from "./bookingForm";
import { setLocale } from "../i18n";

export interface Venue {
  slug: string;
  name: string;
  maxPartySize: number;
  timezone: string;
}

const API = "https://api.tably.example/v1";

export async function mount(el: HTMLElement): Promise<void> {
  el.dataset.tablyMounted = "true";
  setLocale(el.dataset.locale ?? navigator.language);
  const slug = el.dataset.venue;
  if (!slug) return;
  const res = await fetch(`${API}/venues/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    el.textContent = "Online booking is unavailable right now. Please call the restaurant.";
    return;
  }
  const venue = (await res.json()) as Venue;
  renderBookingForm(el, venue, API);
}
