import { join } from "node:path"
import { readJarJson } from "./jar.js"
import { DATAGEN_DIRNAME } from "./structure-sets.js"
import { ensureDir, exists, log, run } from "./util.js"

/**
 * Export worldgen via datagen `--reports` when the vanilla jar ships no structure sets.
 * Runs once per server directory; failures only warn.
 */
export async function ensureWorldgenReports(
  serverDir: string,
  vanillaJar: string | null,
  javaPath: string | null,
): Promise<void> {
  if (!vanillaJar) return
  const bundled = await readJarJson("data/", vanillaJar)
  if (bundled.some(f => f.path.includes("/worldgen/structure_set/"))) return
  const out = join(serverDir, DATAGEN_DIRNAME)
  if (await exists(join(out, "reports", "worldgen"))) return
  const launcher = join(serverDir, "server.jar")
  if (!(await exists(launcher))) {
    log.warn(`vanilla jar has no structure sets and ${launcher} is missing; cannot export datagen reports`)
    return
  }
  await ensureDir(out)
  log.info("vanilla jar has no worldgen JSON, exporting datagen reports…")
  const res = await run(
    javaPath ?? "java",
    ["-DbundlerMainClass=net.minecraft.data.Main", "-jar", launcher, "--reports", "--output", out],
    { cwd: out },
  )
  if (res.code !== 0 || !(await exists(join(out, "reports", "worldgen")))) {
    log.warn(`datagen export failed (code=${res.code}): ${res.stderr.split("\n").slice(-3).join(" ")}`)
  }
}
