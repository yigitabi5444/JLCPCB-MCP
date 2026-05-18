import type {
  ApiEnvelope,
  FilterAttrBody,
  FilterAttrData,
  SearchBody,
  SearchData,
} from "./types.js";

const BASE = "https://jlcpcb.com";
const SEARCH_PATH = "/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2";
const FILTER_PATH = "/api/overseas-pcb-order/v1/componentSearch/filterComponentAttribute";

const SECRETKEY = "64656661756c744b65794964";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

export const MAX_PAGE_SIZE = 50;

export class JLCPCBClient {
  private cookies = new Map<string, string>();
  private bootstrapped = false;

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorbCookies(res: Response): void {
    const list = res.headers.getSetCookie?.() ?? [];
    for (const raw of list) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: BASE,
      Referer: `${BASE}/parts`,
      secretkey: SECRETKEY,
      "x-xsrf-token": this.cookies.get("XSRF-TOKEN") ?? "",
      Cookie: this.cookieHeader(),
      ...extra,
    };
  }

  private async raw(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
      redirect: "follow",
    });
    this.absorbCookies(res);
    return res;
  }

  private async bootstrap(force = false): Promise<void> {
    if (this.bootstrapped && !force) return;
    await this.raw("/parts", { method: "GET" });
    if (!this.cookies.has("XSRF-TOKEN")) {
      await this.raw(SEARCH_PATH, {
        method: "POST",
        body: JSON.stringify({ keyword: "", currentPage: 1, pageSize: 1 }),
      });
    }
    this.bootstrapped = true;
  }

  private async postJson<T>(path: string, body: unknown): Promise<ApiEnvelope<T>> {
    await this.bootstrap();
    let res = await this.raw(path, { method: "POST", body: JSON.stringify(body) });
    if (res.status === 401 || res.status === 403) {
      await this.bootstrap(true);
      res = await this.raw(path, { method: "POST", body: JSON.stringify(body) });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`JLCPCB ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as ApiEnvelope<T>;
  }

  async search(body: SearchBody): Promise<SearchData> {
    const env = await this.postJson<SearchData>(SEARCH_PATH, body);
    if (env.code !== 200 || !env.data) {
      throw new Error(`JLCPCB search failed: code=${env.code} msg=${env.message ?? env.msg ?? ""}`);
    }
    return env.data;
  }

  async filterAttrs(opts: {
    keyword?: string | null;
    productTypeIdList?: number[];
    componentTypeIdList?: number[];
    presaleTypes?: string[];
    componentLibTypes?: string[];
    catalogLevel?: 0 | 1 | 2;
    nowCondition?: string;
    paramList?: { paramName: string; paramValueList: string[] }[];
  } = {}): Promise<FilterAttrData> {
    const body: FilterAttrBody = {
      baseQueryDto: {
        componentBrandList: [],
        componentSpecificationList: [],
        componentTypeIdList: opts.componentTypeIdList ?? [],
        orderLibraryTypeList: [],
        packageTypeList: [],
        filterType: null,
        productTypeIdList: opts.productTypeIdList ?? [],
        presaleTypes: opts.presaleTypes ?? [],
        componentLibTypes: opts.componentLibTypes ?? [],
        pcbAType: null,
        keyword: opts.keyword ?? null,
        queryShelveStatus: null,
      },
      catalogLevel: opts.catalogLevel ?? 2,
      nowCondition: opts.nowCondition ?? "stockType",
      paramList: opts.paramList ?? [],
      queryString: null,
    };
    const env = await this.postJson<FilterAttrData>(FILTER_PATH, body);
    if (env.code !== 200 || !env.data) {
      throw new Error(`JLCPCB filterComponentAttribute failed: code=${env.code} msg=${env.message ?? ""}`);
    }
    return env.data;
  }
}
