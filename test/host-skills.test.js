import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listSkills, readSkillContent } from "../extension/host-skills.js";

async function skill(root, name, body, frontmatter = "") {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), frontmatter ? `---\n${frontmatter}---\n${body}` : body);
}

test("host skills discover global roots and serve bounded content", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-host-skills-"));
  const previous = Object.fromEntries(["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"].map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
  process.env.HOME = home;
  await skill(path.join(home, ".claude", "skills"), "readback", "# Readback\n", "name: readback\ndescription: State the request.\ndisable-model-invocation: true\n");
  await skill(path.join(home, ".agents", "skills"), "readback", "# Wrong copy\n");
  await skill(path.join(home, ".agents", "skills"), "category/grouped", "# Grouped\n");
  await skill(path.join(home, ".codex", "skills"), "model-skill", "# Model\n");
  await skill(path.join(home, ".claude", "skills"), "large", `x`.repeat(20_100), "disable-model-invocation: true\n");

  const skills = await listSkills();
  assert.deepEqual(skills.map((item) => item.name), ["grouped", "large", "model-skill", "readback"]);
  assert.deepEqual(skills.find((item) => item.name === "readback"), {
    name: "readback", root: "claude", description: "State the request.", humanOnly: true, dir: path.join(home, ".claude", "skills", "readback")
  });
  const content = await readSkillContent("readback");
  assert.equal(content.content, "# Readback");
  assert.equal(content.humanOnly, true);
  assert.equal(content.truncated, false);
  assert.equal((await readSkillContent("model-skill")).humanOnly, false);
  assert.equal((await readSkillContent("large")).content.length, 20_000);
  assert.equal((await readSkillContent("large")).truncated, true);
  assert.equal(await readSkillContent("../readback"), null);
  assert.equal(await readSkillContent("missing"), null);
});
