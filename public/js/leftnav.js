/* Shared collapsible left nav for report pages.
   Injects a fixed-position sidebar with cross-page anchor links.
   Active state derives from window.location.pathname.
   Collapse state persists in localStorage('sln-collapsed').
   Champion Management link is hidden unless /api/me indicates whitelisted user. */

(function() {
  'use strict';

  var STORAGE_KEY = 'sln-collapsed';
  var CHAMPION_ADMIN_USERNAMES = ['rd.hill'];

  var NAV_ITEMS = [
    { group: null, items: [
      { href: '/', label: 'Home', match: ['/'],
        icon: '<svg viewBox="0 0 16 16"><path d="M2,8 L8,2 L14,8"/><polyline points="4,8 4,14 12,14 12,8"/></svg>' },
    ]},
    { group: "How We're Doing", items: [
      { href: '/#impact', label: 'Impact Reports', match: ['/report', '/report/quarterly/q1-2026'],
        icon: '<svg viewBox="0 0 16 16"><polyline points="2,12 6,7 9,10 14,4"/><line x1="2" y1="14" x2="14" y2="14"/></svg>' },
    ]},
    { group: 'Trellis Live', items: [
      { href: '/#moms', label: 'Our Moms', match: ['/report/mom-status', '/track-journey', '/report/child-welfare-status'],
        icon: '<svg viewBox="0 0 16 16"><circle cx="6" cy="5" r="2.2"/><circle cx="12" cy="7" r="1.5"/><path d="M2,13 L4,8.5 L8,8.5 L10,13"/><path d="M10,13 L11,9.5 L14,9.5 L15,13"/><line x1="2" y1="13" x2="15" y2="13"/></svg>' },
      { href: '/#advocates', label: 'Our Advocates', match: ['/report/advocate-care'],
        icon: '<svg viewBox="0 0 16 16"><circle cx="8" cy="5.5" r="2.5"/><path d="M3,13.5 C3,10.5 13,10.5 13,13.5"/></svg>' },
      { href: '/#trellis-users', label: 'Trellis Users', match: ['/report/users'],
        icon: '<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="10" rx="1.5"/><line x1="5" y1="14" x2="11" y2="14"/><line x1="8" y1="12" x2="8" y2="14"/></svg>' },
    ]},
    { group: 'Affiliates & Admin', championOnly: true, items: [
      { href: '/admin/champions', label: 'Champion Management', match: ['/admin/champions'], championOnly: true,
        icon: '<svg viewBox="0 0 16 16"><path d="M8,2 L10,6 L14,6.5 L11,9.5 L12,14 L8,11.5 L4,14 L5,9.5 L2,6.5 L6,6 Z"/></svg>' },
    ]},
    { group: null, items: [
      { href: '/integrity', label: 'Our Approach to Data', match: ['/integrity'],
        icon: '<svg viewBox="0 0 16 16"><path d="M8,2 L14,5 L14,10 C14,13 8,15 8,15 C8,15 2,13 2,10 L2,5 Z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="5.5" r=".5" fill="currentColor" stroke="none"/></svg>' },
    ]},
  ];

  function buildNav(isChampionAdmin) {
    var path = window.location.pathname.replace(/\/+$/, '') || '/';

    var html = ''
      + '<div class="sln-collapse-wrap">'
      +   '<button class="sln-collapse-btn" id="sln-toggle-btn" title="Collapse menu" aria-label="Toggle navigation">'
      +     '<svg id="sln-toggle-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="10,3 4,8 10,13"/></svg>'
      +   '</button>'
      + '</div>';

    NAV_ITEMS.forEach(function(section, idx) {
      if (section.championOnly && !isChampionAdmin) return;
      var visibleItems = section.items.filter(function(it) {
        return !it.championOnly || isChampionAdmin;
      });
      if (visibleItems.length === 0) return;

      if (idx > 0) html += '<div class="sln-div"></div>';
      html += '<div class="sln-group">';
      if (section.group) html += '<span class="sln-group-label">' + section.group + '</span>';
      visibleItems.forEach(function(it) {
        // Exact match only — prefix matching would highlight Quarterly Impact
        // for /report/advocate-care, /report/mom-status, etc.
        var isActive = it.match.indexOf(path) !== -1;
        html += '<a class="sln-item' + (isActive ? ' active' : '') + '" href="' + it.href + '">'
          +   '<div class="sln-icon">' + it.icon + '</div>'
          +   '<span class="sln-text">' + it.label + '</span>'
          + '</a>';
      });
      html += '</div>';
    });

    return html;
  }

  function applyCollapseState(collapsed) {
    var nav = document.querySelector('.shared-leftnav');
    var icon = document.getElementById('sln-toggle-icon');
    if (!nav || !icon) return;
    if (collapsed) nav.classList.add('collapsed');
    else nav.classList.remove('collapsed');
    document.body.classList.toggle('nav-collapsed', collapsed);
    icon.innerHTML = collapsed
      ? '<polyline points="6,3 12,8 6,13"/>'
      : '<polyline points="10,3 4,8 10,13"/>';
  }

  function toggleCollapse() {
    var current = localStorage.getItem(STORAGE_KEY) === '1';
    var next = !current;
    try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch (_) {}
    applyCollapseState(next);
  }

  function injectNav(isChampionAdmin) {
    if (document.querySelector('.shared-leftnav')) return;
    var aside = document.createElement('aside');
    aside.className = 'shared-leftnav';
    aside.innerHTML = buildNav(isChampionAdmin);
    document.body.insertBefore(aside, document.body.firstChild);
    document.body.classList.add('shared-leftnav-loaded');

    var btn = document.getElementById('sln-toggle-btn');
    if (btn) btn.addEventListener('click', toggleCollapse);

    var collapsed = localStorage.getItem(STORAGE_KEY) === '1';
    applyCollapseState(collapsed);
  }

  function init() {
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || !data.user) {
          window.location.replace('/');
          return;
        }
        var username = data.user.username || '';
        var isChampionAdmin = CHAMPION_ADMIN_USERNAMES.indexOf(username.toLowerCase()) !== -1;
        injectNav(isChampionAdmin);
      })
      .catch(function() { injectNav(false); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
