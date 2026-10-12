/* Aplica o tema escolhido (claro/escuro) antes de a página aparecer, para não piscar.
   Sem escolha salva, segue o sistema (prefers-color-scheme). */
(function () {
  try {
    var t = localStorage.getItem('garimpo-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (_) { /* navegação privada ou armazenamento bloqueado: segue o sistema */ }
})();
