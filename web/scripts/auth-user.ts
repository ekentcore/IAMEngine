/* Operator/account bootstrap + management from the shell (before any UI auth exists).
 *
 *   npx tsx scripts/auth-user.ts create <email> [role] [--name "Jane Doe"] [--password X] [--break-glass]
 *   npx tsx scripts/auth-user.ts set-password <email> [--password X]
 *   npx tsx scripts/auth-user.ts set-role <email> <role>
 *   npx tsx scripts/auth-user.ts disable|enable <email>
 *   npx tsx scripts/auth-user.ts list
 *
 * role ∈ global_admin | ops_manager | engineer | importer | auditor (default: global_admin for create).
 * When --password is omitted on create/set-password, a strong one is generated and PRINTED ONCE.
 */
import { PrismaClient, type Role } from "@prisma/client";
import { hashPassword, generatePassword } from "../lib/auth/password";

const db = new PrismaClient();
const ROLES: Role[] = ["global_admin", "ops_manager", "engineer", "importer", "auditor"];

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}
function asRole(v: string | undefined, fallback: Role): Role {
  if (!v) return fallback;
  if (!ROLES.includes(v as Role)) throw new Error(`role must be one of: ${ROLES.join(", ")}`);
  return v as Role;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const positional = rest.filter((a) => !a.startsWith("--"));

  switch (cmd) {
    case "create": {
      const email = positional[0]?.trim().toLowerCase();
      if (!email) throw new Error("usage: create <email> [role] ...");
      const role = asRole(positional[1], "global_admin");
      const password = flag(rest, "password") ?? generatePassword();
      const user = await db.user.create({
        data: {
          email,
          name: flag(rest, "name") ?? null,
          role,
          authType: "local",
          passwordHash: hashPassword(password),
          isBreakGlass: has(rest, "break-glass"),
        },
      });
      console.log(`\n✓ created ${user.email}  (role: ${user.role}${user.isBreakGlass ? ", break-glass" : ""})`);
      if (!flag(rest, "password")) console.log(`  password: ${password}   ← shown once; store it now`);
      console.log(`\nNext: set AUTH_ENABLED=true on the app and restart, then sign in at /login.\n`);
      break;
    }
    case "set-password": {
      const email = positional[0]?.trim().toLowerCase();
      if (!email) throw new Error("usage: set-password <email> [--password X]");
      const password = flag(rest, "password") ?? generatePassword();
      await db.user.update({ where: { email }, data: { passwordHash: hashPassword(password) } });
      console.log(`✓ password set for ${email}`);
      if (!flag(rest, "password")) console.log(`  password: ${password}   ← shown once`);
      break;
    }
    case "set-role": {
      const [email, roleArg] = positional;
      if (!email || !roleArg) throw new Error("usage: set-role <email> <role>");
      await db.user.update({ where: { email: email.toLowerCase() }, data: { role: asRole(roleArg, "auditor") } });
      console.log(`✓ ${email} → ${roleArg}`);
      break;
    }
    case "disable":
    case "enable": {
      const email = positional[0]?.trim().toLowerCase();
      if (!email) throw new Error(`usage: ${cmd} <email>`);
      await db.user.update({ where: { email }, data: { status: cmd === "enable" ? "active" : "disabled" } });
      console.log(`✓ ${email} ${cmd}d`);
      break;
    }
    case "list": {
      const users = await db.user.findMany({ orderBy: { createdAt: "asc" }, select: { email: true, role: true, status: true, isBreakGlass: true, lastLoginAt: true } });
      for (const u of users) {
        console.log(`${u.email.padEnd(34)} ${u.role.padEnd(13)} ${u.status.padEnd(9)}${u.isBreakGlass ? " break-glass" : ""}  last: ${u.lastLoginAt?.toISOString() ?? "never"}`);
      }
      if (users.length === 0) console.log("(no users yet — run: create <email>)");
      break;
    }
    default:
      console.log("commands: create | set-password | set-role | disable | enable | list");
  }
}

main()
  .catch((e) => {
    console.error("✗", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
