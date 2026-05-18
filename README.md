# JLCPCB MCP

A Model Context Protocol server that lets Claude search the **JLCPCB SMT parts catalog** in real time via JLCPCB's unofficial live API. No offline database required.

## What it does

Six MCP tools designed for **progressive discovery** — Claude walks down the catalog tree, learns what filters apply to a sub-category, then runs a precise search with **native API filtering and sorting**.

| Tool | What it does |
| --- | --- |
| `list_top_categories` | 62 top-level categories with ids and part counts. Start here. |
| `list_subcategories` | Sub-categories under one top-level category. |
| `list_filters_for_subcategory` | The filters that apply to a sub-category: parametric attributes (with their distinct values and counts), manufacturers, packages. |
| `search_parts` | The actual search. Accepts `subcategory_id`, `keyword`, `attribute_filters: { name: [values] }`, `manufacturers`, `packages`, `library_type`, `in_stock_only`, `min_stock`, `sort_by: relevance \| stock`, pagination. Everything is sent natively to the JLCPCB API. |
| `get_part_details` | Full record for one part by LCSC C-code (e.g. `C25804`). |
| `refresh_category_cache` | Force a refresh of the in-memory category tree (cached on first call). |

**Stock filter (`in_stock_only`) and stock sort (`sort_by: "stock"`) are always available**, regardless of category. Parametric filtering is applied by JLCPCB's API directly — no client-side post-filtering, no sampling.

## Install

```bash
git clone <this-repo> jlcpcb-mcp
cd jlcpcb-mcp
npm install
npm run build
```

Requires Node ≥ 20.

## Wire it into Claude Code

```bash
claude mcp add jlcpcb -- node "$(pwd)/dist/server.js"
```

…or in `~/.config/claude-desktop/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jlcpcb": {
      "command": "node",
      "args": ["/absolute/path/to/JLCPCB MCP/dist/server.js"]
    }
  }
}
```

## End-to-end example: "most stocked 600V N-channel MOSFETs in stock"

The flow Claude follows:

1. **`list_top_categories()`** → finds `Transistors/Thyristors` (id=5).
2. **`list_subcategories({ top_category: "Transistors/Thyristors" })`** → finds `MOSFETs` (id=2954, 72,110 parts).
3. **`list_filters_for_subcategory({ subcategory_id: 2954, in_stock_only: true })`** → returns 17 MOSFET-specific attributes including:
   - `Drain to Source Voltage`: `["5V","6V","7.5V","8V","10V","12V","20V","30V",...,"600V","650V","700V","800V","900V","1200V",...]`
   - `Type`: `["N-Channel","P-Channel","N-Channel + P-Channel"]`
   - `RDS(on)`, `Current - Continuous Drain(Id)`, `Gate Threshold Voltage (Vgs(th))`, `Vgs`, `Configuration`, …
4. **`search_parts({ subcategory_id: 2954, in_stock_only: true, sort_by: "stock", attribute_filters: { "Drain to Source Voltage": ["600V"], "Type": ["N-Channel"] }, page_size: 50 })`** →
   ```text
   Total native-filtered: 636
   Page 1/13, sorted by stockCount DESC (natively by JLCPCB)

    1. C2889158  stock=12,625  2N60G          SOT-223
    2. C46175    stock=10,571  STF13NM60N     TO-220FP
    3. C146208   stock=10,246  STF13N60M2     TO-220FPAB-3
    4. C2928650  stock=10,001  IRFP27N60KPBF  TO-247AC
    5. C39303    stock= 8,651  STN1HNK60      SOT-223
   ...
   ```

## How filtering and sorting work

Behind the scenes, `search_parts` posts to JLCPCB's `selectSmtComponentList/v2` endpoint with native fields:

- `componentAttributeList: [{ "Drain to Source Voltage": ["600V"] }, { "Type": ["N-Channel"] }]` — parametric filter (AND across entries, OR within values).
- `presaleTypes: ["stock"]` — in-stock filter.
- `sortMode: "STOCK_SORT"`, `sortASC: "DESC"` — native sort by stock.
- `startStockNumber: <n>` — minimum stock count.
- `firstSortId` / `secondSortId` (numeric ids) + `firstSortName` / `secondSortName` — category context.

`list_filters_for_subcategory` posts to `componentSearch/filterComponentAttribute` and reads the `paramList` aggregations (which the API computes against the in-stock catalog).

## Tool reference

### `list_top_categories({})`

```jsonc
{
  "total_categories": 62,
  "categories": [
    { "id": 23, "name": "Amplifiers/Comparators", "count": 36672 },
    { "id": 2,  "name": "Capacitors",             "count": 1012296 },
    { "id": 5,  "name": "Transistors/Thyristors", "count": 113092 },
    ...
  ]
}
```

### `list_subcategories({ top_category })`

`top_category` accepts the numeric id as a string (`"5"`) or the exact display name (`"Transistors/Thyristors"`).

```jsonc
{
  "top_category": { "id": 5, "name": "Transistors/Thyristors", "count": 113092 },
  "subcategories": [
    { "id": 2954, "name": "MOSFETs", "count": 72110 },
    { "id": 2934, "name": "Bipolar (BJT)", "count": 19606 },
    ...
  ]
}
```

### `list_filters_for_subcategory({ subcategory_id, in_stock_only? })`

```jsonc
{
  "top_category": { "id": 5, "name": "Transistors/Thyristors" },
  "subcategory":  { "id": 2954, "name": "MOSFETs", "count": 72110 },
  "total_in_subcategory": 37093,
  "always_available_filters": {
    "in_stock_only": true,
    "library_type": ["basic","extended"],
    "sort_by": ["relevance","stock"],
    "min_stock": "integer >= 0"
  },
  "manufacturers": [/* 216 entries */],
  "packages":      [/* 1191 entries */],
  "attributes": [
    {
      "name": "Drain to Source Voltage",
      "values": [
        { "value": "30V", "count": 4892 },
        { "value": "60V", "count": 2104 },
        { "value": "600V", "count": 636 },
        ...
      ]
    },
    { "name": "Type", "values": [
        { "value": "N-Channel", "count": 28150 },
        { "value": "P-Channel", "count": 8800 },
        { "value": "N-Channel + P-Channel", "count": 143 }
    ] },
    { "name": "RDS(on)", "values": [...] },
    ...
  ]
}
```

### `search_parts({ ... })`

| Arg | Type | Default | Notes |
| --- | --- | --- | --- |
| `subcategory_id` | int | — | Required when you pass `attribute_filters`. From `list_subcategories`. |
| `top_category_id` | int | — | Inferred from `subcategory_id`. Pass it explicitly only when scoping without a sub. |
| `keyword` | string | `""` | Free-text. Matches MPN, description, attribute values. |
| `library_type` | `"basic" \| "extended" \| "any"` | `"any"` | JLCPCB Basic vs Extended assembly parts. |
| `manufacturers` | `string[]` | `[]` | Exact brand names. |
| `packages` | `string[]` | `[]` | Exact package names (e.g. `"0402"`, `"TO-247AC"`). |
| `attribute_filters` | `{ [name]: string[] }` | `{}` | `{ "Drain to Source Voltage": ["600V"], "Type": ["N-Channel"] }`. **Applied natively by the API.** AND across attributes, OR within values. |
| `in_stock_only` | boolean | `false` | Only parts with stock > 0. Always available. |
| `min_stock` | int | — | Minimum stock count (native filter). |
| `sort_by` | `"relevance" \| "stock"` | `"relevance"` | `stock` uses the API's `sortMode: STOCK_SORT` / `sortASC: DESC`. |
| `page` | int | `1` | 1-based. |
| `page_size` | int | `20` | Max `50` (JLCPCB API ceiling). |

Returns (abridged):

```jsonc
{
  "total": 636,
  "page": 1, "page_size": 50, "pages": 13, "has_next": true,
  "sort_by": "stock",
  "applied": {
    "subcategory_id": 2954,
    "attribute_filters": { "Drain to Source Voltage": ["600V"], "Type": ["N-Channel"] },
    "in_stock_only": true
  },
  "items": [
    {
      "lcsc": "C2889158",
      "mpn": "2N60G",
      "manufacturer": "...",
      "top_category": "Transistors/Thyristors",
      "sub_category": "MOSFETs",
      "package": "SOT-223",
      "stock": 12625,
      "library_type": "extended",
      "price_breaks": [
        { "qty_min": 1, "qty_max": 99, "unit_price_usd": 0.063 }, ...
      ],
      "datasheet_url": "...",
      "image_url": "...",
      "description": "...",
      "attributes": { "Drain to Source Voltage": "600V", "Type": "N-Channel", ... }
    }
  ]
}
```

### `get_part_details({ lcsc_code })`

Same shape as a search item, plus `image_list` and `component_id`.

### `refresh_category_cache({})`

The category tree (62 top-level → sub-categories) is fetched on the first call to `list_top_categories` / `list_subcategories` and cached for the lifetime of the server. Call this to refresh after a long-running session.

## Notes & caveats

- **Unofficial API.** Endpoints: `POST /api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2` and `POST /api/overseas-pcb-order/v1/componentSearch/filterComponentAttribute`. JLCPCB may change them without notice.
- The client auto-bootstraps a session (`GET /parts` + optional throwaway POST to seed the `XSRF-TOKEN` cookie). No login or API key needed.
- The API's max `pageSize` is **50**. Higher values 500 on the server.
- The category response uses string-form numeric ids in `key`; the MCP normalises them to plain numbers.

## Development

```bash
npm run dev     # tsx, hot stdio MCP
npm test        # live API smoke tests
npm run build   # emit dist/
```

## License

MIT — see [LICENSE](LICENSE).
