// Vitrine: busca nos produtos e destaque da categoria visível. Sem dependências.
(function () {
  var q = document.getElementById('q');
  var none = document.getElementById('none');
  var norm = function (s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); };
  if (q) {
    q.addEventListener('input', function () {
      var term = norm(q.value), found = 0;
      document.querySelectorAll('.cat').forEach(function (sec) {
        var shown = 0;
        sec.querySelectorAll('.pc').forEach(function (c) {
          var ok = !term || norm(c.getAttribute('data-q')).indexOf(term) > -1;
          c.classList.toggle('hide', !ok); if (ok) shown++;
        });
        sec.classList.toggle('hide', !shown); found += shown;
      });
      document.querySelectorAll('.posts,.chips').forEach(function (el) { el.classList.toggle('hide', Boolean(term)); });
      if (none) none.hidden = found > 0;
    });
  }
  var chips = document.querySelectorAll('.chips a');
  if (chips.length && 'IntersectionObserver' in window) {
    var byId = {};
    chips.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        chips.forEach(function (a) { a.classList.remove('on'); });
        var a = byId[e.target.id];
        if (a) { a.classList.add('on'); var bar = a.parentNode; bar.scrollTo({ left: a.offsetLeft - bar.clientWidth / 2 + a.clientWidth / 2, behavior: 'smooth' }); }
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    document.querySelectorAll('.cat').forEach(function (s) { io.observe(s); });
  }
})();
