# Faulty catalog demo app

A small product catalog with a deliberate, deterministic UI defect. It is used by
`npm run demo` and by the integration tests.

```bash
npm run demo:app                       # buggy mode on http://127.0.0.1:4173/catalog
npm run demo:app -- --mode=fixed       # fixed mode
npm run demo:app -- --port=5000
```

## The defect

The page makes these requests (delays are fixed by the server, so timing is deterministic):

| Request                        | Server delay | Purpose                                                |
| ------------------------------ | ------------ | ------------------------------------------------------ |
| `GET /api/products`            | 150 ms       | products, default order                                |
| `GET /api/preferences`         | 600 ms       | the user's preferred sort order                        |
| `GET /api/products?sort=price` | 300 ms       | re-sorted products                                     |
| `GET /api/banner`              | —            | optional promo banner, always **404** (harmless noise) |

In **buggy** mode (`public/catalog.js`, `initBuggy`) the products render after ~150 ms.
When the preferences arrive (~600 ms) the page re-fetches the products in the
preferred order and **re-uses the page-level `loading` flag** for that background
refresh. The full-size loading placeholder (`[data-testid="catalog-loading"]`) is
shown again on top of the already rendered grid (`[data-testid="catalog-grid"]`)
for ~300 ms, which is the reported flicker:

```
t≈0      placeholder visible
t≈150    grid visible, placeholder hidden
t≈600    /api/preferences returns -> placeholder visible again   <-- defect
t≈900    /api/products?sort=price returns -> placeholder hidden
```

The timing is controlled by the server, so the flicker occurs on every load.

### Expected behaviour

Once the catalog content is displayed, the loading placeholder must not re-appear.
There must be a single loading phase per page load.

### The fix

In **fixed** mode (`initFixed`) the page waits for both requests, applies the
preferred order on the client, and leaves the loading state exactly once:

```diff
- const preferences = fetchJSON('/api/preferences');
- const products = await fetchJSON('/api/products');
- state.items = products.items; state.loading = false; render();
- const prefs = await preferences;
- if (prefs.sort !== state.sort) {
-   state.loading = true; render();            // re-enters the page-level loading state
-   const sorted = await fetchJSON(`/api/products?sort=${prefs.sort}`);
-   ...
- }
+ const [prefs, products] = await Promise.all([fetchJSON('/api/preferences'), fetchJSON('/api/products')]);
+ state.items = sortItems(products.items, prefs.sort);
+ state.loading = false;
+ render();
```

The `/api/banner` 404 exists in both modes and is unrelated to the flicker. A good
investigation reports it, but ranks it low and lists contradicting evidence.
