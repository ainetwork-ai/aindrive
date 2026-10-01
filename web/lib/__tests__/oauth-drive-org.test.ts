import { describe, it, expect, vi } from "vitest";
vi.mock("../rate-limit", () => ({ tryConsume: () => ({ok:true}), clientKey: () => "test" }));
vi.mock("../account-tokens", () => ({ ACCOUNT_API_HEADERS: {}, authenticateAccountRequest: () => ({ok:true,token:{userId:"member"}}) }));
vi.mock("../drives", () => ({ listUserDrives: () => [{id:"shared",name:"Team",org_id:"org_comcom"},{id:"personal",name:"Mine"}] }));
vi.mock("../mcp-tokens", () => ({ maxRoleInDrive: () => "viewer" }));
vi.mock("../rpc", () => ({ isOnline: () => true }));
import { GET } from "../../app/api/oauth/drives/route";
describe("OAuth Drive organization metadata", () => {
 it("publishes the verified organization ID and explicit null for personal drives", async () => {
  const response = GET(new Request("https://drive.test/api/oauth/drives"));
  expect((await response.json()).drives).toEqual([
   {id:"shared",name:"Team",orgId:"org_comcom",online:true,role:"viewer"},
   {id:"personal",name:"Mine",orgId:null,online:true,role:"viewer"}
  ]);
 });
});
