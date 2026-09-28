// External script allowed by the local CSP; the scene controller keeps this in sync.
(() => {
  let mode = 'auto';
  try { mode = localStorage.getItem('fuori-studio-daylight') || 'auto'; } catch { /* Private storage may be unavailable. */ }
  const hour = new Date().getHours();
  const night = mode === 'night' || (mode !== 'day' && (hour < 7 || hour >= 19));
  document.documentElement.dataset.theme = night ? 'night' : 'day';
})();
