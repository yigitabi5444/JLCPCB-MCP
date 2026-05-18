#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { JLCPCBClient, MAX_PAGE_SIZE } from "./client.js";
import type { ComponentAttributeFilter, ComponentItem, ProductTypeAgg, SearchBody } from "./types.js";

const client = new JLCPCBClient();

// One-time cached category tree (top-level + subAggs). Refreshes on demand.
let categoryTreeCache: ProductTypeAgg[] | null = null;
let categoryTreePromise: Promise<ProductTypeAgg[]> | null = null;

async function getCategoryTree(force = false): Promise<ProductTypeAgg[]> {
  if (categoryTreeCache && !force) return categoryTreeCache;
  if (!categoryTreePromise || force) {
    categoryTreePromise = (async () => {
      const data = await client.filterAttrs({ catalogLevel: 1, nowCondition: "" });
      categoryTreeCache = data.productTypeAggs ?? [];
      return categoryTreeCache;
    })();
  }
  return categoryTreePromise;
}

function findSubcategory(tree: ProductTypeAgg[], subcategoryId: number): { top: ProductTypeAgg; sub: ProductTypeAgg } | null {
  for (const top of tree) {
    for (const sub of top.subAggs ?? []) {
      if (Number(sub.key) === subcategoryId) return { top, sub };
    }
  }
  return null;
}

function findTopCategory(tree: ProductTypeAgg[], topCategoryIdOrName: number | string): ProductTypeAgg | null {
  const s = String(topCategoryIdOrName);
  for (const top of tree) {
    if (top.key === s || top.name === s) return top;
  }
  return null;
}

// ---------- input schemas ----------

const LibraryTypeEnum = z.enum(["basic", "extended", "any"]).default("any");
const SortByEnum = z.enum(["relevance", "stock"]).default("relevance");

const ListTopCategoriesInput = z.object({});

const ListSubcategoriesInput = z.object({
  top_category: z
    .string()
    .describe(
      "Top-level category — either its numeric id (as a string, e.g. '5') or its exact display name (e.g. 'Transistors/Thyristors'). Get values from list_top_categories.",
    ),
});

const ListFiltersInput = z.object({
  subcategory_id: z
    .number()
    .int()
    .describe("Subcategory numeric id (e.g. 2954 = MOSFETs). Get from list_subcategories."),
  in_stock_only: z.boolean().default(false),
  values_per_attribute: z
    .number()
    .int()
    .min(5)
    .max(200)
    .default(20)
    .describe(
      "Max distinct values to return per attribute (most-common first). Defaults to 20. Use get_attribute_values to enumerate all values for a specific attribute when needed.",
    ),
  min_value_count: z
    .number()
    .int()
    .min(1)
    .default(2)
    .describe(
      "Drop attribute values that appear in fewer than this many parts (kills long-tail noise like 'RDS(on)=1.23nΩ@10V'). Defaults to 2. Set to 1 to include singletons.",
    ),
  include_packages: z.boolean().default(false).describe("Include the full package list (often 1000+ entries). Default false."),
  include_manufacturers: z.boolean().default(false).describe("Include the full manufacturer list (often 200+ entries). Default false."),
});

const GetAttributeValuesInput = z.object({
  subcategory_id: z
    .number()
    .int()
    .describe("Subcategory numeric id (e.g. 2954 = MOSFETs)."),
  attribute_name: z
    .string()
    .describe("Exact attribute name as returned by list_filters_for_subcategory, e.g. 'Drain to Source Voltage'."),
  in_stock_only: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100).describe("Max values to return, most-common first."),
  min_value_count: z.number().int().min(1).default(1),
});

const SearchInput = z.object({
  subcategory_id: z
    .number()
    .int()
    .optional()
    .describe("Subcategory id (e.g. 2954 = MOSFETs). Required when you pass attribute_filters."),
  top_category_id: z
    .number()
    .int()
    .optional()
    .describe("Top-level category id (e.g. 5 = Transistors/Thyristors). Inferred from subcategory_id if not provided."),
  keyword: z.string().default("").describe("Free-text. Matches MPN, description, and attribute values."),
  library_type: LibraryTypeEnum,
  manufacturers: z.array(z.string()).default([]).describe("Exact brand names (use list_filters_for_subcategory)."),
  packages: z.array(z.string()).default([]).describe("Exact package names (e.g. '0402', 'TO-247AC')."),
  attribute_filters: z
    .record(z.string(), z.array(z.string()))
    .default({})
    .describe(
      "Per-attribute filters as { attribute_name: [value, ...] }. Names/values must match what list_filters_for_subcategory returns. Multiple attributes are AND-ed; multiple values per attribute are OR-ed. Applied natively by the JLCPCB API.",
    ),
  in_stock_only: z.boolean().default(false),
  min_stock: z.number().int().min(0).optional().describe("Minimum stock count (API-level filter)."),
  sort_by: SortByEnum.describe("'relevance' (JLCPCB default) or 'stock' (most-stocked first, sorted natively by the API)."),
  page: z.number().int().min(1).default(1),
  page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  verbose: z
    .boolean()
    .default(false)
    .describe("If true, echo the applied filters in the response. Default false (saves tokens — you sent them, you already know)."),
});

const GetPartInput = z.object({
  lcsc_code: z.string().describe("LCSC C-code, e.g. 'C25804'."),
});

const RefreshCacheInput = z.object({});

// ---------- helpers ----------

function mapLibraryType(v: z.infer<typeof LibraryTypeEnum>): { componentLibraryType?: "base" | "expand"; componentLibTypes: string[] } {
  if (v === "basic") return { componentLibraryType: "base", componentLibTypes: ["base"] };
  if (v === "extended") return { componentLibraryType: "expand", componentLibTypes: [] };
  return { componentLibTypes: [] };
}

function shortLibType(s: string | undefined | null): "basic" | "extended" | null {
  if (s === "base") return "basic";
  if (s === "expand") return "extended";
  return null;
}

/** Collapse price tiers to { "<qty_min>": price } — qty_max is implicit (next tier - 1, or unbounded for the last). */
function compactPrices(tiers: ComponentItem["componentPrices"] | undefined | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of tiers ?? []) {
    if (p?.startNumber != null && p?.productPrice != null) {
      out[String(p.startNumber)] = p.productPrice;
    }
  }
  return out;
}

/** Flatten the API's attributes array into a name→value map. Drops placeholders. */
function compactAttrs(attrs: ComponentItem["attributes"] | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) {
    const n = a?.attribute_name_en;
    const v = a?.attribute_value_name;
    if (!n || !v || v === "-" || v.includes("、-")) continue;
    out[n] = v;
  }
  return out;
}

/** Dense per-item summary for search_parts. Drops nulls/empties; top/sub category hoisted to envelope. */
function denseItem(it: ComponentItem): Record<string, unknown> {
  const out: Record<string, unknown> = {
    lcsc: it.componentCode,
    mpn: it.componentModelEn,
    mfr: it.componentBrandEn,
    pkg: it.componentSpecificationEn,
    stock: it.stockCount,
  };
  const lib = shortLibType(it.componentLibraryType as string);
  if (lib) out.lib = lib;
  const prices = compactPrices(it.componentPrices);
  if (Object.keys(prices).length) out.prices_usd = prices;
  const datasheet = it.dataManualOfficialLink || it.dataManualUrl || null;
  if (datasheet) out.datasheet = datasheet;
  const image = it.componentImageUrl || null;
  if (image) out.image = image;
  const attrs = compactAttrs(it.attributes);
  if (Object.keys(attrs).length) out.attrs = attrs;
  return out;
}

/** Full single-part record for get_part_details. Preserves more fields than denseItem. */
function fullItem(it: ComponentItem): Record<string, unknown> {
  return {
    ...denseItem(it),
    component_id: it.componentId,
    top_category: it.secondSortName ?? null,
    sub_category: it.firstSortName ?? it.componentTypeEn ?? null,
    description: it.describe || null,
  };
}

function flatNodes(nodes: ProductTypeAgg[] | null | undefined): { id: number; name: string; count: number }[] {
  return (nodes ?? []).map((n) => ({ id: Number(n.key), name: n.name, count: n.docCount }));
}

/** Compact tuple form for facet values: [value, count]. ~60% smaller than {value, count} objects. */
type FacetTuple = [string, number];
function toTuples(values: { value: string; count: number }[]): FacetTuple[] {
  return values.map((v) => [v.value, v.count] as FacetTuple);
}

/** Serialise without indentation — saves ~30% bytes and tokens. */
function jsonText(obj: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(obj) };
}

/** "Transistors/Thyristors" → "Transistors_Thyristors". JLCPCB uses this in firstSortNameNew. */
function slugifyFirstSortName(name: string): string {
  return name.replace(/\//g, "_");
}

function attrFiltersToList(filters: Record<string, string[]>): ComponentAttributeFilter[] {
  const entries = Object.entries(filters).filter(([, vs]) => vs.length > 0);
  return entries.map(([k, vs]) => ({ [k]: vs }));
}

// ---------- MCP server ----------

const server = new Server(
  { name: "jlcpcb-mcp", version: "0.5.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "list_top_categories",
    description:
      "List all top-level JLCPCB part categories with ids and part counts. Start here. No arguments.",
    inputSchema: zodToJsonSchema(ListTopCategoriesInput),
  },
  {
    name: "list_subcategories",
    description:
      "List sub-categories under one top-level category, with ids and part counts. Pass the subcategory id to list_filters_for_subcategory and search_parts.",
    inputSchema: zodToJsonSchema(ListSubcategoriesInput),
  },
  {
    name: "list_filters_for_subcategory",
    description:
      "Discover filters for a sub-category. Returns attributes[] where each has {name, total_values, values: [[value, count], ...]} — values are TUPLES, sorted by count desc, capped at values_per_attribute (default 20). For a single attribute's full value list, call get_attribute_values. Plus manufacturers {count, sample} and packages {count, sample}. Stock filter is always available via search_parts.in_stock_only.",
    inputSchema: zodToJsonSchema(ListFiltersInput),
  },
  {
    name: "get_attribute_values",
    description:
      "Enumerate values for ONE attribute within a sub-category. Returns values: [[value, count], ...] as TUPLES, count desc. Use when list_filters_for_subcategory's per-attribute cap hid values you need.",
    inputSchema: zodToJsonSchema(GetAttributeValuesInput),
  },
  {
    name: "search_parts",
    description:
      "Search JLCPCB parts. attribute_filters: { name: [values] } — applied natively. sort_by='stock' sorts natively. Items are dense: {lcsc, mpn, mfr, pkg, stock, lib, prices_usd: {<qty_min>: price}, datasheet, image, attrs: {name: value}}. top_category/sub_category are HOISTED to result.context (not per-item). Pagination via page/page_size (max 50). Set verbose=true to echo applied filters.",
    inputSchema: zodToJsonSchema(SearchInput),
  },
  {
    name: "get_part_details",
    description:
      "Full record for one part by LCSC C-code (e.g. 'C25804'). Same dense item schema as search_parts items, plus component_id, top_category, sub_category, description.",
    inputSchema: zodToJsonSchema(GetPartInput),
  },
  {
    name: "refresh_category_cache",
    description: "Force a refresh of the in-memory category tree cache. No arguments.",
    inputSchema: zodToJsonSchema(RefreshCacheInput),
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;

  try {
    switch (name) {
      case "list_top_categories": {
        const tree = await getCategoryTree();
        const cats = flatNodes(tree).sort((a, b) => a.name.localeCompare(b.name));
        return { content: [jsonText({ count: cats.length, categories: cats })] };
      }

      case "list_subcategories": {
        const { top_category } = ListSubcategoriesInput.parse(rawArgs ?? {});
        const tree = await getCategoryTree();
        const top = findTopCategory(tree, top_category);
        if (!top) {
          return {
            isError: true,
            content: [{ type: "text", text: `Top-level category '${top_category}' not found. Call list_top_categories first.` }],
          };
        }
        const subs = flatNodes(top.subAggs).sort((a, b) => a.name.localeCompare(b.name));
        return {
          content: [
            jsonText({
              top_category: { id: Number(top.key), name: top.name, count: top.docCount },
              subcategories: subs,
            }),
          ],
        };
      }

      case "list_filters_for_subcategory": {
        const input = ListFiltersInput.parse(rawArgs ?? {});
        const tree = await getCategoryTree();
        const ctx = findSubcategory(tree, input.subcategory_id);
        if (!ctx) {
          return {
            isError: true,
            content: [{ type: "text", text: `subcategory_id ${input.subcategory_id} not found in category tree.` }],
          };
        }
        const data = await client.filterAttrs({
          componentTypeIdList: [input.subcategory_id],
          productTypeIdList: [Number(ctx.top.key)],
          presaleTypes: input.in_stock_only ? ["stock"] : [],
          catalogLevel: 2,
          nowCondition: "stockType",
        });

        // MOSFET-type parametric facets land in `paramList`. parentParamList / parentParamRangeList
        // are used in other contexts (no subcategory). Merge all three, dedup by name.
        const seen = new Set<string>();
        type Collected = { name: string; total_values: number; values: FacetTuple[] };
        const collected: Collected[] = [];
        let collectedSortKeys = new Map<string, number>(); // for sorting by total parts
        for (const src of [data.paramList ?? [], data.parentParamList ?? [], data.parentParamRangeList ?? []]) {
          for (const p of src) {
            if (!p?.name || seen.has(p.name)) continue;
            const raw = (p.subAggs ?? [])
              .map((s) => ({ value: s.name, count: s.docCount }))
              .filter((v) => v.value && v.value !== "-" && !v.value.includes("、-"));
            if (!raw.length) continue;
            const above = raw.filter((v) => v.count >= input.min_value_count);
            const useable = above.length ? above : raw;
            useable.sort((a, b) => b.count - a.count);
            const totalParts = useable.reduce((s, v) => s + v.count, 0);
            const capped = useable.slice(0, input.values_per_attribute);
            seen.add(p.name);
            collected.push({ name: p.name, total_values: useable.length, values: toTuples(capped) });
            collectedSortKeys.set(p.name, totalParts);
          }
        }
        collected.sort((a, b) => (collectedSortKeys.get(b.name) ?? 0) - (collectedSortKeys.get(a.name) ?? 0));

        const allMfrs = data.componentBrandList ?? [];
        const allPkgs = data.componentSpecificationList ?? [];

        return {
          content: [
            jsonText({
              subcategory: { id: Number(ctx.sub.key), name: ctx.sub.name, parent: ctx.top.name },
              total: data.total,
              values_format: "[value, count]",
              manufacturers: input.include_manufacturers
                ? { count: allMfrs.length, all: allMfrs }
                : { count: allMfrs.length, sample: allMfrs.slice(0, 30) },
              packages: input.include_packages
                ? { count: allPkgs.length, all: allPkgs }
                : { count: allPkgs.length, sample: allPkgs.slice(0, 30) },
              attributes: collected,
            }),
          ],
        };
      }

      case "get_attribute_values": {
        const input = GetAttributeValuesInput.parse(rawArgs ?? {});
        const tree = await getCategoryTree();
        const ctx = findSubcategory(tree, input.subcategory_id);
        if (!ctx) {
          return {
            isError: true,
            content: [{ type: "text", text: `subcategory_id ${input.subcategory_id} not found in category tree.` }],
          };
        }
        const data = await client.filterAttrs({
          componentTypeIdList: [input.subcategory_id],
          productTypeIdList: [Number(ctx.top.key)],
          presaleTypes: input.in_stock_only ? ["stock"] : [],
          catalogLevel: 2,
          nowCondition: "stockType",
        });
        const wanted = input.attribute_name.toLowerCase();
        const pools = [data.paramList ?? [], data.parentParamList ?? [], data.parentParamRangeList ?? []];
        let hit: { name: string; subAggs?: { name: string; docCount: number }[] | null } | null = null;
        for (const pool of pools) {
          const found = pool.find((p) => p?.name?.toLowerCase() === wanted);
          if (found) {
            hit = found;
            break;
          }
        }
        if (!hit) {
          return {
            isError: true,
            content: [{ type: "text", text: `Attribute '${input.attribute_name}' not found for this subcategory. Call list_filters_for_subcategory to see attribute names.` }],
          };
        }
        const raw = (hit.subAggs ?? [])
          .map((s) => ({ value: s.name, count: s.docCount }))
          .filter((v) => v.value && v.value !== "-" && !v.value.includes("、-"));
        const filtered = raw.filter((v) => v.count >= input.min_value_count).sort((a, b) => b.count - a.count);
        const total_values = filtered.length;
        const sliced = filtered.slice(0, input.limit);
        return {
          content: [
            jsonText({
              subcategory: { id: Number(ctx.sub.key), name: ctx.sub.name },
              attribute: hit.name,
              total_values,
              truncated: total_values > sliced.length,
              values_format: "[value, count]",
              values: toTuples(sliced),
            }),
          ],
        };
      }

      case "search_parts": {
        const input = SearchInput.parse(rawArgs ?? {});
        const body: SearchBody = {
          currentPage: input.page,
          pageSize: input.page_size,
          keyword: input.keyword || null,
          searchSource: "search",
          searchType: 3,
          paramList: [],
          firstSortNameList: [],
        };

        // Resolve category context if subcategory_id given.
        if (input.subcategory_id != null) {
          const tree = await getCategoryTree();
          const ctx = findSubcategory(tree, input.subcategory_id);
          if (!ctx) {
            return {
              isError: true,
              content: [{ type: "text", text: `subcategory_id ${input.subcategory_id} not found. Call list_top_categories / list_subcategories first.` }],
            };
          }
          body.secondSortId = Number(ctx.sub.key);
          body.secondSortName = ctx.sub.name;
          body.firstSortId = input.top_category_id ?? Number(ctx.top.key);
          body.firstSortName = ctx.top.name;
          body.firstSortNameNew = slugifyFirstSortName(ctx.top.name);
        } else if (input.top_category_id != null) {
          const tree = await getCategoryTree();
          const top = findTopCategory(tree, input.top_category_id);
          if (top) {
            body.firstSortId = Number(top.key);
            body.firstSortName = top.name;
            body.firstSortNameNew = slugifyFirstSortName(top.name);
          } else {
            body.firstSortId = input.top_category_id;
          }
        }

        const lt = mapLibraryType(input.library_type);
        if (lt.componentLibraryType) body.componentLibraryType = lt.componentLibraryType;
        body.componentLibTypes = lt.componentLibTypes;

        if (input.manufacturers.length) body.componentBrandList = input.manufacturers;
        if (input.packages.length) body.componentSpecificationList = input.packages;

        const attrList = attrFiltersToList(input.attribute_filters);
        if (attrList.length) body.componentAttributeList = attrList;

        if (input.in_stock_only) body.presaleTypes = ["stock"];
        if (input.min_stock != null) body.startStockNumber = input.min_stock;

        if (input.sort_by === "stock") {
          body.sortMode = "STOCK_SORT";
          body.sortASC = "DESC";
        }

        const data = await client.search(body);
        const list = data.componentPageInfo.list ?? [];
        const items = list.map(denseItem);

        // Hoist category context out of each item (saves bytes; agent already knows it filtered by subcat).
        const ctxOut: Record<string, string> | undefined = list[0]
          ? {
              top_category: list[0].secondSortName ?? "",
              sub_category: list[0].firstSortName ?? list[0].componentTypeEn ?? "",
            }
          : undefined;

        const result: Record<string, unknown> = {
          total: data.componentPageInfo.total,
          page: data.componentPageInfo.pageNum,
          page_size: data.componentPageInfo.pageSize,
          pages: data.componentPageInfo.pages,
          sort: input.sort_by,
          items,
        };
        if (ctxOut && (ctxOut.top_category || ctxOut.sub_category)) result.context = ctxOut;
        if (input.verbose) {
          result.applied = {
            keyword: input.keyword || null,
            subcategory_id: input.subcategory_id ?? null,
            attribute_filters: input.attribute_filters,
            manufacturers: input.manufacturers,
            packages: input.packages,
            library_type: input.library_type,
            in_stock_only: input.in_stock_only,
            min_stock: input.min_stock ?? null,
          };
        }
        return { content: [jsonText(result)] };
      }

      case "get_part_details": {
        const { lcsc_code } = GetPartInput.parse(rawArgs ?? {});
        const data = await client.search({
          currentPage: 1,
          pageSize: 1,
          keyword: lcsc_code,
          searchSource: "search",
          searchType: 3,
        });
        const item = data.componentPageInfo.list?.[0];
        if (!item) {
          return {
            isError: true,
            content: [{ type: "text", text: `No part found for LCSC code '${lcsc_code}'.` }],
          };
        }
        return { content: [jsonText(fullItem(item))] };
      }

      case "refresh_category_cache": {
        const tree = await getCategoryTree(true);
        return { content: [{ type: "text", text: `Refreshed. ${tree.length} top-level categories loaded.` }] };
      }

      default:
        return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: msg }] };
  }
});

// Minimal zod -> JSON Schema. Only the subset that MCP clients consume.
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "object", properties: {}, required: [] };
  const props = out.properties as Record<string, unknown>;
  const required = out.required as string[];

  if (!(schema instanceof z.ZodObject)) {
    return { type: "object" };
  }
  const shape = schema.shape as Record<string, z.ZodTypeAny>;

  for (const [key, field] of Object.entries(shape)) {
    let f = field;
    let optional = false;
    let description: string | undefined;

    if (f._def?.description) description = f._def.description;
    while (f instanceof z.ZodOptional || f instanceof z.ZodDefault) {
      optional = true;
      f = (f._def as { innerType: z.ZodTypeAny }).innerType;
      if (!description && f._def?.description) description = f._def.description;
    }

    let entry: Record<string, unknown> = {};
    if (f instanceof z.ZodString) entry = { type: "string" };
    else if (f instanceof z.ZodNumber) entry = { type: "number" };
    else if (f instanceof z.ZodBoolean) entry = { type: "boolean" };
    else if (f instanceof z.ZodArray) entry = { type: "array", items: { type: "string" } };
    else if (f instanceof z.ZodEnum) entry = { type: "string", enum: [...f.options] };
    else if (f instanceof z.ZodRecord)
      entry = { type: "object", additionalProperties: { type: "array", items: { type: "string" } } };
    else entry = {};

    if (description) entry.description = description;

    props[key] = entry;
    if (!optional) required.push(key);
  }
  if (!required.length) delete (out as { required?: unknown }).required;
  return out;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("jlcpcb-mcp ready");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
