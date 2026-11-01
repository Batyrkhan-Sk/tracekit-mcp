// Catalog page logic. The server injects window.CATALOG_CONFIG = { mode: 'buggy' | 'fixed' }.
(function () {
  const config = window.CATALOG_CONFIG || { mode: 'buggy' };
  const overlay = document.querySelector('[data-testid="catalog-loading"]');
  const grid = document.querySelector('[data-testid="catalog-grid"]');
  const sortLabel = document.querySelector('[data-testid="sort-order"]');

  const state = { loading: true, items: [], sort: 'name' };

  function render() {
    overlay.hidden = !state.loading;
    grid.hidden = state.items.length === 0;
    sortLabel.textContent = state.sort;
    grid.innerHTML = state.items
      .map((item) => `<li><strong>${item.name}</strong><div class="price">$${item.price}</div></li>`)
      .join('');
  }

  async function fetchJSON(url) {
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return body;
  }

  function sortItems(items, sort) {
    const copy = [...items];
    return sort === 'price'
      ? copy.sort((a, b) => a.price - b.price)
      : copy.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Optional promo banner. The endpoint does not exist; the failure is handled and is unrelated to the flicker.
  async function loadBanner() {
    try {
      await fetchJSON('/api/banner');
    } catch (error) {
      console.warn('Promo banner unavailable:', error.message);
    }
  }

  // BUGGY: products and preferences load independently. When the (slower) preferences
  // response arrives, the page re-sorts by refetching and re-uses the page-level
  // `loading` flag for that background refresh. The full-page loading placeholder
  // therefore covers content that has already been rendered: a visible flicker
  // on every load/refresh.
  async function initBuggy() {
    state.loading = true;
    render();
    const preferences = fetchJSON('/api/preferences');
    const products = await fetchJSON('/api/products');
    state.items = products.items;
    state.loading = false;
    render();

    const prefs = await preferences;
    if (prefs.sort !== state.sort) {
      state.loading = true; // <-- the defect
      render();
      const sorted = await fetchJSON(`/api/products?sort=${encodeURIComponent(prefs.sort)}`);
      state.items = sorted.items;
      state.sort = prefs.sort;
      state.loading = false;
      render();
    }
  }

  // FIXED: wait for both requests, apply the preferred order client-side, and
  // leave the loading state exactly once.
  async function initFixed() {
    state.loading = true;
    render();
    const [prefs, products] = await Promise.all([fetchJSON('/api/preferences'), fetchJSON('/api/products')]);
    state.sort = prefs.sort;
    state.items = sortItems(products.items, prefs.sort);
    state.loading = false;
    render();
  }

  void loadBanner();
  (config.mode === 'fixed' ? initFixed() : initBuggy()).catch((error) => {
    console.error('Catalog failed to load:', error);
  });
})();
