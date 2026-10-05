import type { Venue } from "./mount";
import { fetchSlots } from "./availability";
import { t } from "../i18n";

export function renderBookingForm(root: HTMLElement, venue: Venue, api: string): void {
  const form = document.createElement("form");
  form.className = "tably-form";

  const party = document.createElement("select");
  // TODO: respect venue.maxPartySize (see "Party size dropdown ignores the venue's max covers")
  for (let n = 1; n <= 12; n++) party.add(new Option(t("guests", { n }), String(n)));

  const name = document.createElement("input");
  name.placeholder = t("name");
  const email = document.createElement("input");
  email.type = "email";
  email.placeholder = t("email");

  const slots = document.createElement("div");
  const picker = document.createElement("div");
  // The date picker is most of the bundle; load it only when the guest starts booking.
  party.addEventListener("focus", () => void import("./datePicker").then(({ renderDatePicker }) => {
    if (picker.childElementCount) return;
    picker.append(renderDatePicker(onPick));
  }), { once: true });

  async function onPick(dateKey: string): Promise<void> {
    slots.replaceChildren();
    for (const slot of await fetchSlots(api, venue.slug, dateKey, Number(party.value))) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = slot.time;
      b.onclick = () => form.dataset.slot = slot.id;
      slots.append(b);
    }
  }

  const submit = document.createElement("button");
  submit.textContent = t("book");
  form.append(party, picker, slots, name, email, submit);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch(`${api}/venues/${venue.slug}/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: form.dataset.slot, party: Number(party.value), name: name.value, email: email.value }),
    });
    root.textContent = res.ok ? t("confirmed", { venue: venue.name }) : t("failed");
  };
  root.replaceChildren(form);
}
