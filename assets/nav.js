// Mobile navigation toggle, shared by every page (see assets/nav.css).
(function () {
  var toggle = document.querySelector('.nav-toggle');
  if (!toggle) return;
  var nav = toggle.closest('nav');

  function setOpen(open) {
    nav.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  function isOpen() { return nav.classList.contains('menu-open'); }

  toggle.addEventListener('click', function () { setOpen(!isOpen()); });
  // Following a link (or opening the contact modal) closes the menu.
  nav.addEventListener('click', function (e) { if (isOpen() && e.target.closest('a')) setOpen(false); });
  document.addEventListener('click', function (e) { if (isOpen() && !nav.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen()) { setOpen(false); toggle.focus(); } });
  window.addEventListener('resize', function () { if (window.innerWidth > 1000 && isOpen()) setOpen(false); });
})();
