export type LibraryType = "base" | "expand";
export type SortMode = "STOCK_SORT" | "PRICE_SORT" | "RELEVANCE_SORT";
export type SortDirection = "ASC" | "DESC";

/** Parametric attribute filter: each entry is a single-key object whose key is the attribute name and value is an OR-list of strings. */
export type ComponentAttributeFilter = Record<string, string[]>;

export interface SearchBody {
  currentPage: number;
  pageSize: number;
  keyword?: string | null;
  componentLibraryType?: LibraryType | null;
  /** API-level "in stock" filter — the live UI uses presaleTypes: ["stock"] for this. */
  presaleTypes?: string[];
  componentLibTypes?: string[];
  pcbAType?: string | null;
  componentBrandList?: string[];
  componentSpecificationList?: string[];
  /** Native parametric filter — each entry is { "<attr>": ["v1","v2", ...] }. */
  componentAttributeList?: ComponentAttributeFilter[];
  paramList?: unknown[];
  /** Min stock; null = no limit. */
  startStockNumber?: number | null;
  firstSortId?: number | null;
  secondSortId?: number | null;
  firstSortName?: string | null;
  secondSortName?: string | null;
  firstSortNameNew?: string | null;
  firstSortNameList?: string[];
  searchSource?: string;
  searchType?: number;
  sortMode?: SortMode;
  sortASC?: SortDirection;
  /** Legacy fields kept for compat with older internal callers (smoke tests). */
  stockFlag?: 0 | 1 | null;
  productTypeIdList?: number[];
  componentTypeIdList?: number[];
  secondSortNameList?: string[];
}

export interface PriceTier {
  startNumber: number;
  endNumber: number;
  productPrice: number;
}

export interface AttributeKV {
  attribute_name_en: string;
  attribute_value_name: string;
  attribute_value_name_high?: string;
}

export interface ComponentItem {
  componentId: number;
  componentCode: string;
  componentModelEn: string;
  componentBrandEn: string;
  componentTypeEn: string;
  componentSpecificationEn: string;
  componentLibraryType: LibraryType | string;
  stockCount: number;
  componentPrices: PriceTier[];
  buyComponentPrices?: PriceTier[];
  dataManualUrl?: string | null;
  dataManualOfficialLink?: string | null;
  componentImageUrl?: string | null;
  imageList?: unknown[];
  describe?: string | null;
  attributes?: AttributeKV[] | null;
  firstSortName?: string;
  secondSortName?: string;
  firstSortAccessId?: string;
  secondSortAccessId?: string;
}

export interface PageInfo<T> {
  list: T[];
  total: number;
  pageNum: number;
  pageSize: number;
  pages: number;
  isFirstPage: boolean;
  isLastPage: boolean;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

export interface SearchData {
  componentPageInfo: PageInfo<ComponentItem>;
  brandList?: string[];
  basePart?: number | null;
  preferredPart?: number | null;
  economicPart?: number | null;
  standardPart?: number | null;
  dataSheetPart?: number | null;
  photo?: number | null;
  queryString?: string;
}

export interface ApiEnvelope<T> {
  success?: boolean;
  code: number;
  message?: string;
  msg?: string;
  data: T | null;
}

/** From filterComponentAttribute — top-level / sub-category aggregations. */
export interface ProductTypeAgg {
  key: string;
  name: string;
  docCount: number;
  displayFlag?: boolean;
  subAggs?: ProductTypeAgg[] | null;
}

export interface ParamAgg {
  key: string;
  name: string;
  docCount: number;
  displayFlag?: boolean;
  subAggs?: ParamAgg[] | null;
}

export interface FilterAttrData {
  total: number;
  componentTypeList: ProductTypeAgg[];
  productTypeList: ProductTypeAgg[];
  productTypeAggs: ProductTypeAgg[];
  componentBrandList: string[];
  componentSpecificationList: string[];
  parentParamList?: ParamAgg[] | null;
  parentParamRangeList?: ParamAgg[] | null;
  paramList?: ParamAgg[] | null;
}

/** Body for filterComponentAttribute — wrapped baseQueryDto. */
export interface FilterAttrBody {
  baseQueryDto: {
    componentBrandList: string[];
    componentSpecificationList: string[];
    componentTypeIdList: number[];
    orderLibraryTypeList: string[];
    packageTypeList: string[];
    filterType: number | null;
    productTypeIdList: number[];
    presaleTypes: string[];
    componentLibTypes: string[];
    pcbAType: string | null;
    keyword: string | null;
    queryShelveStatus: number | null;
  };
  catalogLevel: 0 | 1 | 2;
  nowCondition: string;
  paramList: { paramName: string; paramValueList: string[] }[];
  queryString: string | null;
}
