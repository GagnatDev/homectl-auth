/**
 * Registers the PWA service worker (public/sw.js), which is copied to the site
 * root at build time and served from our own origin. Skipped in dev so its
 * caching never interferes with hot-reload, and when the browser lacks support,
 * so calling this unconditionally at startup is safe.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  // Register after load so it never competes with the initial app boot.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // A failed registration must never break the app — just log it.
      console.warn('Service worker registration failed:', err);
    });
  });
}
