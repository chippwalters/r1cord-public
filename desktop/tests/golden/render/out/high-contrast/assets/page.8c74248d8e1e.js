// R1CORD page script: theme toggle and contents panel. Fixed code, no page data; the same
// behaviour as MD DOCS' browser export (sessionStorage key, expand/collapse).
(function () {
  'use strict';
  var body = document.body;
  var THEME_KEY = 'altuit-toc-theme';

  var themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    var saved = null;
    try { saved = sessionStorage.getItem(THEME_KEY); } catch (e) { saved = null; }
    if (saved === 'dark' || saved === 'light') body.setAttribute('data-theme', saved);
    themeToggle.addEventListener('click', function () {
      var next = (body.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
      body.setAttribute('data-theme', next);
      try { sessionStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.toc-toggle'), function (toggle) {
    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var section = toggle.closest('.toc-section');
      if (section) section.classList.toggle('collapsed');
    });
  });

  var expandAll = document.getElementById('tocExpandAll');
  if (expandAll) {
    expandAll.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.toc-section'), function (s) {
        s.classList.remove('collapsed');
      });
    });
  }

  var collapseAll = document.getElementById('tocCollapseAll');
  if (collapseAll) {
    collapseAll.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.toc-section'), function (s) {
        var children = s.querySelector('.toc-children');
        if (children && children.children.length > 0) s.classList.add('collapsed');
      });
    });
  }

  // The page navigation can wrap the header onto a second row (large-type themes, narrow
  // windows), taller than the theme's sticky contents panel and anchor offsets expect. Keep
  // both clear of the header.
  var header = document.querySelector('.site-header');
  var toc = document.querySelector('nav.toc');
  function fitHeader() {
    if (!header || !toc) return;
    var root = document.documentElement;
    toc.style.top = '';
    toc.style.maxHeight = '';
    root.style.scrollPaddingTop = '';
    var style = getComputedStyle(toc);
    var height = header.getBoundingClientRect().height;
    if (style.position !== 'sticky' || height + 12 <= (parseFloat(style.top) || 0)) return;
    toc.style.top = (height + 16) + 'px';
    toc.style.maxHeight = 'calc(100vh - ' + (height + 32) + 'px)';
    root.style.scrollPaddingTop = (height + 12) + 'px';
  }
  fitHeader();
  window.addEventListener('resize', fitHeader);
  window.addEventListener('load', fitHeader);
})();
