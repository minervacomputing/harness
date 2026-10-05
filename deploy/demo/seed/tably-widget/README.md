# Tably widget

The embeddable table-booking widget for independent restaurants, and the billing code behind the
restaurant dashboard. Made by Fernhill Labs in London.

## Embed

```html
<div id="tably" data-venue="trattoria-rossa" data-locale="en-GB"></div>
<script src="https://cdn.tably.example/widget.js" async></script>
```

## Develop

```sh
npm install
npm test          # vitest
npm run typecheck
npm run build     # dist/widget.js
```

## Layout

| Path | What |
|---|---|
| `src/widget` | Mounting, booking form, availability, date picker |
| `src/i18n` | Strings (English only for now) |
| `src/billing` | Plans and card checkout for restaurants (Stripe) |
| `src/reminders` | Booking reminder emails |

Billing runs server-side in the dashboard API; it lives here so the widget and the plans share types.

## On call

See "Engineering on-call" in the Fernhill Wiki.
