// Mirrors mobile/android/app/src/test/java/ai/ainetwork/aindrive/agent/QueryParserTest.java and FollowUpTest.java
/**
 * The parser IS the agent's understanding of a question. A tiny gazetteer keeps
 * these self-contained; the real one is the bundled GeoNames table.
 */
process.env.TZ = "Asia/Seoul";

import { test } from "node:test";
import assert from "node:assert/strict";
import { GeoLookup } from "../agent/geo-lookup.js";
import { LARGE_BYTES, QueryParser } from "../agent/query-parser.js";
import { SearchQuery } from "../agent/search-query.js";

const at = (y, m, d) => new Date(y, m - 1, d).getTime();
const NOW = at(2026, 9, 23);
const geo = GeoLookup.load("# name\tcountry\tlat\tlon\tpop\tko\n"
  + "Paris\tFR\t48.85341\t2.3488\t2138551\t파리\n"
  + "Seoul\tKR\t37.566\t126.9784\t10349312\t서울특별시\n"
  + "Jeju City\tKR\t33.50972\t126.52194\t408000\t제주시\n"
  + "New York City\tUS\t40.71427\t-74.00597\t8804190\t뉴욕 시\n"
  + "Nice\tFR\t43.70313\t7.26608\t342669\t니스\n"
  + "Paris\tUS\t33.66094\t-95.55551\t24782\t\n"
  + "Boulogne-Billancourt\tFR\t48.83333\t2.25\t120071\t불로뉴비양쿠르\n"
  + "Goyang-si\tKR\t37.65639\t126.835\t1073069\t고양시\n"
  + "London\tGB\t51.50853\t-0.12574\t8961989\t런던\n");
const parser = new QueryParser(geo);
const parse = (s, prev) => parser.parse(s, NOW, prev);

test("Korean city with a particle", () => {
  const q = parse("파리에서 찍은 사진 찾아줘");
  assert.equal(q.city, "Paris"); assert.equal(q.country, "FR"); assert.equal(q.dateFrom, null); assert.equal(q.textQuery(), null); assert.ok(q.korean);
});

test("Korean country", () => {
  const q = parse("프랑스 여행 갔던 사진");
  assert.equal(q.country, "FR"); assert.equal(q.city, null); assert.equal(q.textQuery(), null);
});

test("last summer with a city and content", () => {
  const q = parse("작년 여름 제주시 바다 사진");
  assert.equal(q.country, "KR"); assert.equal(q.city, "Jeju City");
  assert.equal(q.dateFrom, at(2025, 6, 1)); assert.equal(q.dateTo, at(2025, 9, 1)); assert.equal(q.textQuery(), "바다");
});

test("year and month in Korean", () => {
  const q = parse("2024년 5월 파리 야경");
  assert.equal(q.city, "Paris"); assert.equal(q.dateFrom, at(2024, 5, 1)); assert.equal(q.dateTo, at(2024, 6, 1)); assert.equal(q.textQuery(), "야경");
});

test("English multi-word city and month", () => {
  const q = parse("show me photos from New York in May 2024");
  assert.equal(q.city, "New York City"); assert.equal(q.country, "US"); assert.equal(q.dateFrom, at(2024, 5, 1)); assert.equal(q.textQuery(), null);
});

test("English country alias and last year", () => {
  const q = parse("pictures I took in the UK last year");
  assert.equal(q.country, "GB"); assert.equal(q.dateFrom, at(2025, 1, 1)); assert.equal(q.dateTo, at(2026, 1, 1));
});

test("last summer in English", () => {
  const q = parse("photos from Jeju last summer");
  assert.equal(q.city, "Jeju City"); assert.equal(q.dateFrom, at(2025, 6, 1)); assert.equal(q.dateTo, at(2025, 9, 1)); assert.equal(q.textQuery(), null);
});

test("the Korean administrative suffix is optional", () => {
  assert.equal(parse("서울 사진").city, "Seoul");
  assert.equal(parse("서울특별시에서 찍은 사진").city, "Seoul");
  assert.equal(parse("제주 사진").city, "Jeju City");
  assert.equal(parse("뉴욕 사진").city, "New York City");
});

test("the subject marker is not stripped for places", () => {
  // 고양이 = cat; 고양 = Goyang. Only locative particles unlock a place.
  const q = parse("고양이 사진 보여줘");
  assert.equal(q.city, null); assert.equal(q.textQuery(), "고양이");
  assert.equal(parse("고양에서 찍은 사진").city, "Goyang-si");
});

test("kinds and recency", () => {
  let q = parse("recent PDFs");
  assert.equal(q.kind, "pdf"); assert.equal(q.dateFrom, at(2026, 8, 24)); assert.equal(q.textQuery(), null);
  q = parse("지난주 스크린샷");   // 2026-09-23 is a Wednesday → last week = Sep 14–20
  assert.equal(q.kind, "screenshot"); assert.equal(q.dateFrom, at(2026, 9, 14)); assert.equal(q.dateTo, at(2026, 9, 21));
  q = parse("계약서 pdf 파일");
  assert.equal(q.kind, "pdf"); assert.equal(q.textQuery(), "계약서");
  q = parse("큰 영상 파일");
  assert.equal(q.kind, "video"); assert.equal(q.minSize, LARGE_BYTES);
});

test("task words become actions", () => {
  let q = parse("이번달에 먹은 음식사진만 모아서 폴더로 만들어서 공유해줘");
  assert.equal(q.kind, "photo"); assert.equal(q.textQuery(), "음식"); assert.equal(q.dateFrom, at(2026, 9, 1)); assert.ok(q.collect); assert.ok(q.share);
  q = parse("collect my dog photos into a folder");
  assert.equal(q.kind, "photo"); assert.equal(q.textQuery(), "dog"); assert.ok(q.collect);
  q = parse("강아지 사진");
  assert.ok(!q.collect && !q.share);
});

test("more task grammar", () => {
  let q = parse("파리 사진 몇 장 있어?");
  assert.ok(q.count); assert.equal(q.city, "Paris"); assert.equal(q.textQuery(), null);
  q = parse("how many screenshots do I have");
  assert.ok(q.count); assert.equal(q.kind, "screenshot"); assert.equal(q.textQuery(), null);
  q = parse("가장 최근 사진 3장만 보여줘");
  assert.equal(q.limit, 3); assert.equal(q.kind, "photo"); assert.equal(q.textQuery(), null);
  q = parse("가장 큰 파일 5개");
  assert.equal(q.limit, 5); assert.ok(q.bySize); assert.equal(q.minSize, null);
  q = parse("가장 오래된 사진 2장");
  assert.ok(q.oldestFirst); assert.equal(q.limit, 2);
  q = parse("강아지 사진 삭제해줘");
  assert.ok(q.delete); assert.equal(q.textQuery(), "강아지"); assert.ok(!q.collect);
  q = parse("스크린샷 전부 폴더로 옮겨줘");
  assert.ok(q.move && q.collect); assert.equal(q.kind, "screenshot"); assert.equal(q.textQuery(), null);
  q = parse("move the pizza photos into a folder");
  assert.ok(q.move); assert.equal(q.textQuery(), "pizza");
});

test("a bare folder and leading fillers", () => {
  let q = parse("서울 사진 모아서 폴더 만들어");
  assert.ok(q.collect); assert.equal(q.city, "Seoul"); assert.equal(q.textQuery(), null);
  q = parse("한국 사진 폴더로 정리");
  assert.ok(q.collect); assert.equal(q.country, "KR"); assert.equal(q.textQuery(), null);
  q = parse("put all the Korea photos in a folder");
  assert.ok(q.collect); assert.equal(q.country, "KR"); assert.equal(q.textQuery(), null);
  q = parse("share my London photos as a folder");
  assert.ok(q.share && q.collect); assert.equal(q.city, "London"); assert.equal(q.textQuery(), null);
  q = parse("노을 사진 폴더 만들어");
  assert.ok(q.collect); assert.equal(q.textQuery(), "노을");
});

test("winter spans the year boundary", () => {
  const q = parse("2023년 겨울 사진");
  assert.equal(q.dateFrom, at(2023, 12, 1)); assert.equal(q.dateTo, at(2024, 3, 1));
});

test("no place, no date: content only", () => {
  const q = parse("강아지 사진 보여줘");
  assert.equal(q.country, null); assert.equal(q.dateFrom, null); assert.equal(q.textQuery(), "강아지");
});

test("the biggest city wins a name collision", () => {
  assert.equal(geo.byPlaceName("paris")?.country, "FR");   // Paris, TX (24k) must not shadow Paris, FR
});

test("GPS → nearest city", () => {
  assert.equal(geo.nearest(48.8584, 2.2945)?.name, "Paris");   // Eiffel Tower
  assert.equal(geo.nearest(0, -30), null);                      // mid-Atlantic
});

test("relative-date phrases", () => {
  let q = parse("photos from 3 days ago");
  assert.equal(q.dateFrom, at(2026, 9, 20)); assert.equal(q.dateTo, at(2026, 9, 21));
  q = parse("videos from two months ago");
  assert.equal(q.dateFrom, at(2026, 7, 1)); assert.equal(q.dateTo, at(2026, 8, 1));
  q = parse("screenshots from the past week");
  assert.equal(q.dateFrom, at(2026, 9, 16)); assert.equal(q.dateTo, at(2026, 9, 24));
  q = parse("photos from last weekend");
  assert.equal(q.dateFrom, at(2026, 9, 19)); assert.equal(q.dateTo, at(2026, 9, 21));
  q = parse("photos from December");   // December is still ahead in September → last December
  assert.equal(q.dateFrom, at(2025, 12, 1)); assert.equal(q.dateTo, at(2026, 1, 1));
});

// FollowUpTest.java — its own two-city gazetteer
const fparser = new QueryParser(GeoLookup.load("Paris\tFR\t48.85\t2.35\t2000000\t파리\nTokyo\tJP\t35.68\t139.69\t9000000\t도쿄\n"));
const FNOW = 1790000000000;
const follow = (first, then) => fparser.parse(then, FNOW, SearchQuery.fromJson(fparser.parse(first, FNOW).toJson()));

test("a task-only question inherits the filters", () => {
  let q = follow("photos taken in Paris", "collect them into a folder and share it");
  assert.equal(q.city, "Paris"); assert.equal(q.kind, "photo"); assert.ok(q.collect); assert.ok(q.share); assert.ok(q.followUp);
  q = follow("dog photos", "how many are there?");
  assert.ok(q.count); assert.deepEqual(q.keywords, ["dog"]);
  q = follow("파리 사진", "그거 폴더로 모아서 공유해줘");
  assert.equal(q.city, "Paris"); assert.ok(q.share);
});

test("a refinement overrides but keeps the rest", () => {
  let q = follow("photos taken in Paris", "only the ones from this month");
  assert.equal(q.city, "Paris"); assert.equal(q.kind, "photo"); assert.notEqual(q.dateFrom, null);
  q = follow("photos from Paris", "and the ones from Tokyo");
  assert.equal(q.city, "Tokyo");
});

test("a new question does not inherit", () => {
  const q = follow("photos taken in Paris", "meeting recordings about the budget");
  assert.equal(q.city, null); assert.equal(q.kind, "audio"); assert.ok(!q.followUp);
});

test("the context round-trips (also through JSON text)", () => {
  const q = fparser.parse("dog photos from Paris this month", FNOW);
  const back = SearchQuery.fromJson(JSON.parse(JSON.stringify(q.toJson())));
  assert.equal(back.city, q.city); assert.equal(back.kind, q.kind); assert.equal(back.dateFrom, q.dateFrom); assert.deepEqual(back.keywords, q.keywords);
  assert.equal(SearchQuery.fromJson(fparser.parse("share it", FNOW).toJson()), null);   // nothing to carry
});

test("\"what's in this folder?\" is where to look, not a task; only \"into a folder\" makes one", () => {
  for (const q of ["what's in this folder?", "list this folder", "이 폴더에 뭐 있어?", "현재 폴더 보여줘"]) {
    const x = parse(q);
    assert.equal(x.collect, false, q);
    assert.deepEqual(x.keywords, [], q);
  }
  assert.equal(parse("photos in this folder").kind, "photo");
  for (const q of ["collect them into a folder", "put the Tokyo photos in a folder", "make an album of the Paris photos", "폴더로 모아줘"]) assert.equal(parse(q).collect, true, q);
});
