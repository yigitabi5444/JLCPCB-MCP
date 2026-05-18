import { test } from "node:test";
import assert from "node:assert/strict";
import { JLCPCBClient } from "../src/client.ts";

test("search by exact LCSC code returns one item", async () => {
  const c = new JLCPCBClient();
  const data = await c.search({ keyword: "C25804", currentPage: 1, pageSize: 1 });
  assert.equal(data.componentPageInfo.total, 1, "C25804 should be a unique part");
  const item = data.componentPageInfo.list[0];
  assert.equal(item.componentCode, "C25804");
  assert.ok(item.componentBrandEn, "manufacturer should be populated");
  assert.ok(item.stockCount >= 0, "stock should be a number");
});

test("keyword + library_type=base + in_stock_only returns Basic parts only", async () => {
  const c = new JLCPCBClient();
  const data = await c.search({
    keyword: "resistor",
    currentPage: 1,
    pageSize: 5,
    componentLibraryType: "base",
    stockFlag: 1,
  });
  assert.ok(data.componentPageInfo.total > 0, "should have some basic resistors");
  for (const it of data.componentPageInfo.list) {
    assert.equal(it.componentLibraryType, "base", `${it.componentCode} should be base`);
    assert.ok(it.stockCount > 0, `${it.componentCode} should be in stock`);
  }
});

test("category filter (top-level Resistors) narrows results", async () => {
  const c = new JLCPCBClient();
  const data = await c.search({
    currentPage: 1,
    pageSize: 5,
    firstSortNameList: ["Resistors"],
  });
  assert.ok(data.componentPageInfo.total > 0);
  for (const it of data.componentPageInfo.list) {
    // remember the API/response naming is flipped — secondSortName is the top-level
    assert.equal(it.secondSortName, "Resistors", `${it.componentCode} top-level should be Resistors`);
  }
});
