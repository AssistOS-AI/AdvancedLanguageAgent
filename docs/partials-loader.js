async function loadPartials() {
  const includes = [...document.querySelectorAll('[data-include]')];
  await Promise.all(includes.map(async (element) => {
    const response = await fetch(element.dataset.include);
    if (!response.ok) {
      throw new Error(`Unable to load ${element.dataset.include}`);
    }
    element.innerHTML = await response.text();
  }));
}

function initializeNavigation() {
  const menus = [...document.querySelectorAll('.nav-menu')];

  function closeMenu(menu, restoreFocus = false) {
    const trigger = menu.querySelector('.nav-trigger');
    menu.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }

  for (const menu of menus) {
    const trigger = menu.querySelector('.nav-trigger');
    trigger.addEventListener('click', () => {
      const shouldOpen = !menu.classList.contains('is-open');
      for (const candidate of menus) closeMenu(candidate);
      if (shouldOpen) {
        menu.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });

    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.classList.contains('is-open')) {
        closeMenu(menu, true);
      }
    });
  }

  document.addEventListener('pointerdown', (event) => {
    for (const menu of menus) {
      if (!menu.contains(event.target)) closeMenu(menu);
    }
  });
}

loadPartials()
  .then(initializeNavigation)
  .catch((error) => {
    console.error(error);
    initializeNavigation();
  });
