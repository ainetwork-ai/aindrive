import catalog from "ain-ui/catalog.json";

export function GET() {
  return Response.json(catalog, { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
}
