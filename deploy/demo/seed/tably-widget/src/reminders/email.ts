export interface Booking {
  id: string;
  guestName: string;
  guestEmail: string;
  venueName: string;
  startsAt: string; // ISO, venue local time
  party: number;
  cancelUrl: string;
}

/** The reminder sent 24 hours before a booking. SMS reminders are not built yet. */
export function reminderEmail(b: Booking): { to: string; subject: string; text: string } {
  const when = new Date(b.startsAt).toLocaleString("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit" });
  return {
    to: b.guestEmail,
    subject: `Your table at ${b.venueName} tomorrow`,
    text:
      `Hi ${b.guestName},\n\nThis is a reminder of your booking for ${b.party} at ${b.venueName}, ${when}.\n\n` +
      `Can't make it? Please cancel so someone else can have the table: ${b.cancelUrl}\n`,
  };
}
