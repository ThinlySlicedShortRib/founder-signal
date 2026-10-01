// Used only by `pnpm auth:schema` to generate Better Auth's Drizzle tables.
// Keep the plugin list in sync with apps/api/src/auth.ts (only plugins that add tables matter).
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";

export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "pg" }),
  plugins: [emailOTP({ async sendVerificationOTP() {} })],
});
