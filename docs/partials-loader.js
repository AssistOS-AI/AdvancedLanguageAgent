document.querySelectorAll('[data-include]').forEach(async (element) => {
  const response = await fetch(element.dataset.include);
  if (response.ok) element.innerHTML = await response.text();
});
