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
  "subcategory": { "id": 2954, "name": "MOSFETs", "parent": "Transistors/Thyristors" },
  "total": 37093,
  "values_format": "[value, count]",
  "manufacturers": { "count": 216, "sample": ["Infineon Technologies", "Vishay Intertech", ...] },
  "packages":      { "count": 1191, "sample": ["SOT-23", "DPAK", "TO-220", ...] },
  "attributes": [
    {
      "name": "Drain to Source Voltage",
      "total_values": 103,
      "values": [
        ["30V", 14210],
        ["60V", 10030],
        ["600V", 3066],
        ...
      ]
    },
    { "name": "Type", "total_values": 3, "values": [["N-Channel", 28150], ["P-Channel", 8800], ["N-Channel + P-Channel", 143]] },
    { "name": "RDS(on)", "total_values": 1022, "values": [["5mΩ@10V", ...], ...] }
  ]
}
```

`values` are emitted as `[value, count]` tuples (sorted by count desc). Use `get_attribute_values` for the full list of a single attribute when `total_values` exceeds the per-attribute cap. Pass `include_manufacturers: true` / `include_packages: true` to get the full lists instead of the 30-entry sample.

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
| `verbose` | boolean | `false` | If true, response also includes an `applied` block echoing the filters. |

Returns dense JSON (no whitespace, common fields hoisted, empty fields omitted):

```jsonc
{
  "total": 636,
  "page": 1, "page_size": 50, "pages": 13,
  "sort": "stock",
  "context": { "top_category": "Transistors/Thyristors", "sub_category": "MOSFETs" },
  "items": [
    {
      "lcsc": "C2889158",
      "mpn": "2N60G",
      "mfr": "UMW(Youtai Semiconductor Co., Ltd.)",
      "pkg": "SOT-223",
      "stock": 12625,
      "lib": "extended",
      "prices_usd": { "1": 0.1037, "50": 0.0807, "150": 0.0691, "500": 0.0605, "2500": 0.0484, "5000": 0.0449 },
      "datasheet": "https://...",
      "image": "https://...",
      "attrs": { "Drain to Source Voltage": "600V", "Type": "N-Channel", "RDS(on)": "4.2Ω@10V", ... }
    }
  ]
}
```

Field notes:
- `prices_usd` is a `{qty_min: unit_price}` map. `qty_max` for each tier is implicit (next break − 1; the highest key has no upper bound).
- `lib` is `basic` or `extended`.
- `attrs` is a flat `{name: value}` map (placeholders like `-` are stripped).
- Empty fields (`datasheet`, `image`) are omitted, not emitted as `null` / `""`.
- `context` is hoisted out of each item — every item in the same page shares the same category, so it appears once at the envelope.
- Pass `verbose: true` to also receive an `applied` block echoing the filters you sent.

### `get_part_details({ lcsc_code })`

Same dense item schema as `search_parts` items, plus `component_id`, `top_category`, `sub_category`, `description`.

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
