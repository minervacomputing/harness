import { mount } from "./widget/mount";

// Mount every placeholder on the page, including ones added after load (Squarespace, Wix).
function mountAll(): void {
  document.querySelectorAll<HTMLElement>("[data-venue]:not([data-tably-mounted])").forEach(mount);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountAll);
} else {
  mountAll();
}
window.addEventListener("mercury:load", mountAll);
