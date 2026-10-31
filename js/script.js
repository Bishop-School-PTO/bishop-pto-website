const navToggle = document.getElementById('navToggle');
const primaryNav = document.getElementById('primaryNav');

navToggle.addEventListener('click', () => {
  const isOpen = primaryNav.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', String(isOpen));
});

primaryNav.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    primaryNav.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
  });
});

// ---------------------------------------------------
// PR previews and Edit Mode (editor is loaded on demand)
// ---------------------------------------------------
const scriptUrl = document.currentScript.src;
const preview = location.pathname.match(/\/pr\/(\d+)\//);
const editLinks = document.querySelectorAll('[data-edit]');

if (preview) {
  // This is a preview of an open pull request (built by .github/workflows/pages.yml).
  editLinks.forEach((link) => { link.hidden = true; });
  fetch(new URL('edit/config.json', scriptUrl)).then((r) => r.json()).then(({ repo }) => {
    const banner = document.createElement('div');
    banner.className = 'site-banner site-banner--info';
    banner.innerHTML = `<div class="wrap site-banner-inner"><p><strong>Preview of proposed change #${preview[1]}</strong> &mdash; not live yet.
      <a href="https://github.com/${repo}/pull/${preview[1]}">Review it on GitHub</a> &middot;
      <a href="${location.pathname.slice(0, preview.index + 1)}">Go to the live site</a></p></div>`;
    (document.querySelector('.site-banners') || document.body).prepend(banner);
  });
} else {
  const startEditing = () => {
    sessionStorage.setItem('pto-edit', '1');
    import(new URL('edit/editor.js', scriptUrl)).catch((err) => alert(`Edit Mode failed to load: ${err.message}`));
  };
  editLinks.forEach((link) => link.addEventListener('click', (e) => { e.preventDefault(); startEditing(); }));
  if (sessionStorage.getItem('pto-edit') || location.hash === '#edit') startEditing();
  // Also when "#edit" is added to the address of a page that's already open.
  addEventListener('hashchange', () => { if (location.hash === '#edit') startEditing(); });
}
