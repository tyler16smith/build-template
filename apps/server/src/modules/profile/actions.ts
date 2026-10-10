import { profileGet, profileUpdate } from "@template/contracts";
import { defineAction } from "../../actions/define";

/** The CRUD example every module copies: read and update, through the registry. */

export const getProfile = defineAction({
  ...profileGet,
  handler: async (ctx) => ctx.account.profile(),
});

export const updateProfile = defineAction({
  ...profileUpdate,
  handler: async (ctx, input) => {
    const profile = await ctx.account.updateProfile(input);
    ctx.log.info("profile.updated", { changed: Object.keys(input) });
    return profile;
  },
});
