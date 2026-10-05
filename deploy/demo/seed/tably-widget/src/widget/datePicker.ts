// A small dependency-free date picker: the next 60 days as buttons.

export function toDateKey(d: Date): string {
  // BUG: toISOString() is UTC. At 00:00 local time during BST this is 23:00 the day before.
  return d.toISOString().slice(0, 10);
}

export function renderDatePicker(onPick: (dateKey: string) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tably-dates";
  const today = new Date();
  for (let i = 0; i < 60; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    b.onclick = () => onPick(toDateKey(d));
    wrap.append(b);
  }
  return wrap;
}
