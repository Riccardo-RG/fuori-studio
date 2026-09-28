const paths = {
  memory: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4M7 8h4m-4 4h10"/>',
  projects: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V4h8v3M3 12h18m-11 0v3h4v-3"/>',
  workflows: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h6a3 3 0 0 1 3 3v6M3 18h6m-3-3v6"/>',
  context: '<circle cx="12" cy="12" r="4"/><circle cx="4" cy="4" r="2"/><circle cx="20" cy="5" r="2"/><circle cx="6" cy="21" r="2"/><path d="m6 6 3 3m6 0 3-3m-7 10-3 3"/>',
  meeting: '<ellipse cx="12" cy="13" rx="8" ry="4"/><path d="M6 16v4m12-4v4"/><circle cx="5" cy="5" r="2"/><circle cx="12" cy="3" r="2"/><circle cx="19" cy="5" r="2"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 0 1 5-13h4a8 8 0 0 1 8 8Z"/><path d="M8 10h8m-8 4h5"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  personal: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  shared: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
  moon: '<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>'
};

export function icon(name, className = '') {
  return `<svg class="studio-icon ${className}" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.context}</svg>`;
}
