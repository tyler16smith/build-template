import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ACTIONS,
  ALL_PERMISSIONS,
  assignableRoles,
  invitableRoles,
  mayChangeMember,
  mayRun,
  PERMISSIONS,
  permissionsOf,
  roleCan,
  rolePermissions,
  slugify,
  Slug,
  type Role,
} from "../src";

const ROLES: Role[] = ["owner", "admin", "member"];
const person = (userId: string, role: Role) => ({ userId, role });

describe("permissions", () => {
  it("gives owners every permission, and every permission to some role", () => {
    expect([...rolePermissions.owner].sort()).toEqual([...ALL_PERMISSIONS].sort());
    for (const permission of ALL_PERMISSIONS)
      expect(
        ROLES.some((role) => roleCan(role, permission)),
        permission,
      ).toBe(true);
    // Every permission an action names exists.
    for (const action of Object.values(ACTIONS))
      if ("permission" in action && action.permission)
        expect(Object.keys(PERMISSIONS)).toContain(action.permission);
  });

  it("matches the spec's table", () => {
    expect(permissionsOf("admin").sort()).toEqual([
      "ai.usage",
      "automations.manage",
      "members.manage",
      "organization.manage",
    ]);
    expect(permissionsOf("member")).toEqual([]);
    expect(permissionsOf(null)).toEqual([]);
  });

  it("lets anyone run an action without a permission, and only holders run the rest", () => {
    expect(mayRun(ACTIONS["members.list"], "member")).toBe(true);
    expect(mayRun(ACTIONS["members.remove"], "member")).toBe(false);
    expect(mayRun(ACTIONS["members.remove"], "admin")).toBe(true);
    expect(mayRun(ACTIONS["organization.delete"], "admin")).toBe(false);
    expect(mayRun(ACTIONS["organization.delete"], "owner")).toBe(true);
    expect(mayRun(ACTIONS["members.list"], null)).toBe(false);
  });

  it("never takes an organization from input", () => {
    for (const action of Object.values(ACTIONS))
      expect(
        JSON.stringify(z.toJSONSchema(action.input, { io: "input", unrepresentable: "any" })),
        action.id,
      ).not.toMatch(/"organization_?id"/i);
  });
});

describe("who can change whom", () => {
  const bea = person("bea", "owner");
  const rex = person("rex", "owner");
  const hank = person("hank", "admin");
  const hamlet = person("hamlet", "admin");
  const stu = person("stu", "member");

  it("lets owners change or remove anyone, and grant owner", () => {
    expect(mayChangeMember({ actor: bea, target: hank, newRole: "member" })).toBeNull();
    expect(mayChangeMember({ actor: bea, target: rex, newRole: null })).toBeNull();
    expect(mayChangeMember({ actor: bea, target: stu, newRole: "owner" })).toBeNull();
  });

  it("lets admins promote members and remove them, but not touch admins or owners", () => {
    expect(mayChangeMember({ actor: hank, target: stu, newRole: "admin" })).toBeNull();
    expect(mayChangeMember({ actor: hank, target: stu, newRole: null })).toBeNull();
    expect(mayChangeMember({ actor: hank, target: stu, newRole: "owner" })).toMatch(/owners/);
    expect(mayChangeMember({ actor: hank, target: hamlet, newRole: "member" })).toMatch(
      /another admin/,
    );
    expect(mayChangeMember({ actor: hank, target: bea, newRole: "admin" })).toMatch(/owner/);
    expect(mayChangeMember({ actor: hank, target: bea, newRole: null })).toMatch(/owner/);
  });

  it("lets anyone lower their own role or leave, never raise it", () => {
    expect(mayChangeMember({ actor: stu, target: stu, newRole: null })).toBeNull();
    expect(mayChangeMember({ actor: hank, target: hank, newRole: "member" })).toBeNull();
    expect(mayChangeMember({ actor: stu, target: stu, newRole: "admin" })).toMatch(/raise/);
    expect(mayChangeMember({ actor: stu, target: hank, newRole: "member" })).toMatch(
      /Only owners and admins/,
    );
  });

  it("offers only the roles that would be allowed", () => {
    expect(assignableRoles(bea, stu)).toEqual(["owner", "admin", "member"]);
    expect(assignableRoles(hank, stu)).toEqual(["admin", "member"]);
    expect(assignableRoles(hank, hamlet)).toEqual(["admin"]);
    expect(assignableRoles(stu, stu)).toEqual(["member"]);
    expect(invitableRoles("admin")).toEqual(["admin", "member"]);
    expect(invitableRoles("member")).toEqual([]);
  });
});

describe("slugs", () => {
  it("come from the name, and keep reserved words free", () => {
    expect(slugify("Three Pigs Construction")).toBe("three-pigs-construction");
    expect(slugify("Huff & Puff Testing")).toBe("huff-and-puff-testing");
    expect(slugify("Ünïcode Ćo.")).toBe("unicode-co");
    expect(slugify("AB")).toBe("ab-co");
    expect(slugify("Admin")).toBe("admin-co");
    expect(Slug.safeParse("settings").success).toBe(false);
    expect(Slug.safeParse("Bad Slug").success).toBe(false);
    expect(Slug.parse(" Big-Bad-Demolition ")).toBe("big-bad-demolition");
  });
});
