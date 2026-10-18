// Vitrine: categorias recolhidas (toque abre), busca que abre as categorias com resultado. Sem dependências.
(function () {
  var cats = Array.prototype.slice.call(document.querySelectorAll('details.cat'));
  var q = document.getElementById('q');
  var none = document.getElementById('none');
  var norm = function (s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); };

  // link direto para uma categoria (#c12): já abre e rola até ela
  function openHash() {
    var el = location.hash && document.getElementById(location.hash.slice(1));
    if (el && el.tagName === 'DETAILS') { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
  openHash();
  window.addEventListener('hashchange', openHash);

  var lastSearch = 0;
  // ao abrir uma categoria, leva o topo dela para a tela (no celular a lista pode ficar abaixo)
  cats.forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (d.open && Date.now() - lastSearch > 400) { // aberta pela busca: não rola
        var top = d.getBoundingClientRect().top;
        if (top < 0 || top > window.innerHeight * 0.6) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  if (!q) return;
  var before = null; // quais estavam abertas antes de buscar
  q.addEventListener('input', function () {
    var term = norm(q.value), found = 0;
    lastSearch = Date.now();
    if (term && !before) before = cats.map(function (d) { return d.open; });
    cats.forEach(function (d, i) {
      var shown = 0;
      d.querySelectorAll('.pc').forEach(function (c) {
        var ok = !term || norm(c.getAttribute('data-q')).indexOf(term) > -1;
        c.classList.toggle('hide', !ok); if (ok) shown++;
      });
      d.classList.toggle('hide', !shown);
      d.open = term ? shown > 0 : Boolean(before && before[i]);
      found += shown;
    });
    if (!term) before = null;
    document.querySelectorAll('.posts').forEach(function (el) { el.classList.toggle('hide', Boolean(term)); });
    if (none) none.hidden = found > 0;
  });
})();
