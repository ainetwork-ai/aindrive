// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/index/GeoLookup.java
/**
 * Offline gazetteer: GPS → nearest city/country, and place NAME → city/country
 * for the query parser. Backed by the bundled GeoNames cities15000 table
 * (assets/geo/cities.tsv.gz, ~34k rows, sorted by population desc).
 *
 * Country names: the phone asks java.util.Locale; the Mac reads the same table
 * dumped from the JDK (assets/geo/countries.tsv) rather than Node's ICU, whose
 * CLDR version — and so names like "Türkiye" / "Hong Kong SAR China" — varies.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { javaTrim } from "./java-regex.js";

const ASSETS = fileURLToPath(new URL("../../assets/geo/", import.meta.url));

/** Only cities at least this big are matchable by name — keeps "Nice" from matching a hamlet. */
const NAME_MATCH_MIN_POP = 50_000;
/** Longest first, so 특별자치시 is not cut as 시. */
const KO_ADMIN_SUFFIXES = ["특별자치시", "특별자치도", "특별시", "광역시", " 시", "시", "군"];

/** Everyday names Locale does not produce. */
const ALIASES = [
  ["usa", "US"], ["u.s.", "US"], ["america", "US"], ["미국", "US"],
  ["uk", "GB"], ["england", "GB"], ["britain", "GB"], ["영국", "GB"],
  ["korea", "KR"], ["한국", "KR"], ["대한민국", "KR"], ["south korea", "KR"],
  ["불란서", "FR"], ["홀랜드", "NL"], ["holland", "NL"], ["네덜란드", "NL"],
  ["czechia", "CZ"], ["체코", "CZ"], ["러시아", "RU"], ["vietnam", "VN"], ["베트남", "VN"],
  ["taiwan", "TW"], ["대만", "TW"], ["uae", "AE"], ["dubai", "AE"],
  ["turkey", "TR"], ["터키", "TR"], ["튀르키예", "TR"], ["czech republic", "CZ"], ["the netherlands", "NL"],
];

let countryRows = null;
/** [iso, English, Korean] per ISO country, as Locale.getISOCountries() lists them. */
function countries() {
  if (countryRows == null) {
    countryRows = readFileSync(ASSETS + "countries.tsv", "utf8").split("\n")
      .filter((l) => l !== "" && l[0] !== "#").map((l) => l.split("\t"));
  }
  return countryRows;
}

const cellOf = (latCell, lonCell) => (latCell + 90) * 360 + (lonCell + 180);
const cell = (lat, lon) => cellOf(Math.floor(lat), Math.floor(lon));
const wrapLon = (c) => (c < -180 ? c + 360 : c >= 180 ? c - 360 : c);
const rad = (d) => (d / 180) * Math.PI;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371, dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * r * Math.asin(Math.sqrt(a));
}

/** Integer.parseInt, or 0 when it would throw. */
function parseIntSafe(s) {
  if (!/^[+-]?\d+$/.test(s)) return 0;
  const n = Number(s);
  return n >= -2147483648 && n <= 2147483647 ? n : 0;
}

/**
 * @typedef {{ name: string, country: string, lat: number, lon: number, pop: number, ko: string | null }} City
 * @typedef {{ country: string | null, city: string | null }} Place  country: ISO-3166 alpha-2; city: GeoNames name
 */
export class GeoLookup {
  constructor() {
    /** @type {City[]} */
    this.cities = [];
    /** 1°×1° cells → indices into `cities`. */
    this.grid = new Map();
    /** lowercase English / Korean city name → biggest city with that name. */
    this.byName = new Map();
    /** lowercase English / Korean country name (and aliases) → ISO code. */
    this.countryByName = new Map();
    this.countryEnByIso = new Map();
    this.countryKoByIso = new Map();
  }

  /** The bundled table (desktop/assets/geo/cities.tsv.gz). */
  static loadDefault() {
    return GeoLookup.loadGzip(readFileSync(ASSETS + "cities.tsv.gz"));
  }

  /** @param {Buffer} gz gzipped TSV: name, country, lat, lon, population, Korean name */
  static loadGzip(gz) {
    return GeoLookup.load(gunzipSync(gz).toString("utf8"));
  }

  /** @param {string} tsv the plain TSV text */
  static load(tsv) {
    const g = new GeoLookup();
    for (const line of tsv.split(/\r\n|\r|\n/)) {
      if (line === "" || line[0] === "#") continue;
      const c = line.split("\t");
      if (c.length < 5) continue;
      const city = { name: c[0], country: c[1], lat: Number(javaTrim(c[2])), lon: Number(javaTrim(c[3])), pop: parseIntSafe(c[4]), ko: c.length > 5 && c[5] !== "" ? c[5] : null };
      const idx = g.cities.length;
      g.cities.push(city);
      const k = cell(city.lat, city.lon);
      if (!g.grid.has(k)) g.grid.set(k, []);
      g.grid.get(k).push(idx);
      if (city.pop >= NAME_MATCH_MIN_POP) {
        // Rows are population-desc, so the first writer wins = the biggest city.
        const en = city.name.toLowerCase();
        putIfAbsent(g.byName, en, city);
        // "New York City" / "Jeju City" are asked for as "New York" / "Jeju".
        if (en.endsWith(" city")) putIfAbsent(g.byName, en.slice(0, -5), city);
        if (city.ko != null) {
          putIfAbsent(g.byName, city.ko, city);
          // 서울특별시 → 서울, 부산광역시 → 부산, 제주시 → 제주, 뉴욕 시 → 뉴욕.
          for (const suffix of KO_ADMIN_SUFFIXES) {
            if (city.ko.length > suffix.length + 1 && city.ko.endsWith(suffix)) {
              putIfAbsent(g.byName, javaTrim(city.ko.slice(0, city.ko.length - suffix.length)), city);
              break;
            }
          }
        }
      }
    }
    g.loadCountries();
    return g;
  }

  loadCountries() {
    for (const [iso, en, ko] of countries()) {
      this.countryEnByIso.set(iso, en);
      this.countryKoByIso.set(iso, ko);
      this.countryByName.set(en.toLowerCase(), iso);
      if (ko) this.countryByName.set(ko, iso);
    }
    for (const [name, iso] of ALIASES) this.countryByName.set(name, iso);
  }

  /**
   * The city a photo "was taken in": within ~100 km, the lowest distance / sqrt(population).
   * @returns {City | null}
   */
  nearest(lat, lon) {
    let best = null, bestScore = Number.MAX_VALUE;
    const la = Math.floor(lat), lo = Math.floor(lon);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.grid.get(cellOf(la + dy, wrapLon(lo + dx)));
        if (!bucket) continue;
        for (const i of bucket) {
          const c = this.cities[i];
          const km = haversineKm(lat, lon, c.lat, c.lon);
          if (km > 100) continue;
          const score = km / Math.sqrt(Math.max(c.pop, 1000));
          if (score < bestScore) { bestScore = score; best = c; }
        }
      }
    }
    return best;
  }

  /** Exact (case-insensitive) match on a city or country name. @returns {Place | null} */
  byPlaceName(raw) {
    const k = javaTrim(raw).toLowerCase();
    if (k === "") return null;
    const iso = this.countryByName.get(k);
    if (iso != null) return { country: iso, city: null };
    const c = this.byName.get(k);
    if (c != null) return { country: c.country, city: c.name };
    return null;
  }

  /** The country's name in English or Korean; the ISO code when unknown. */
  countryName(iso, korean) {
    const n = (korean ? this.countryKoByIso : this.countryEnByIso).get(iso);
    return n == null || n === "" ? iso : n;
  }

  /** The Korean name of a (GeoNames-named) city, or null. */
  cityKo(cityName) {
    const c = this.byName.get(cityName.toLowerCase());
    return c == null ? null : c.ko;
  }
}

function putIfAbsent(map, k, v) {
  if (!map.has(k)) map.set(k, v);
}
