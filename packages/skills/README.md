# @fadenstack/skills

Agent Skills on the device for a [Fadenstack](https://fadenstack.com) agent: instructions and reference files for a task, as two
read tools, `load_skill` and `read_skill_resource`. The package has its own loader (the .NET SDK runs Microsoft Agent Framework's
`AgentSkillsProvider`; there is no such framework in TypeScript), with the same two tools and the same behaviour.

```bash
npm install @fadenstack/client @fadenstack/agents @fadenstack/skills
```

```ts
import { FadenstackAgent } from "@fadenstack/agents";
import { skillsModule } from "@fadenstack/skills";

const skills = skillsModule({
  bundled: [{ name: "slide-design", description: "Designs a slide.", body: "One idea per slide." }],
});

const agent = FadenstackAgent.createBuilder().useClient(client).useAgent("browser-assistant").use(skills).build();

await skills.store?.add({ name: "house-style", description: "Writes replies in the house style.", body: "Greet the customer by name." });
```

- **Two tools, class read.** The model is told the skills' names and descriptions, loads a skill's instructions with `load_skill` and
  reads one of its listed files with `read_skill_resource`, by the name the skill lists. Neither asks the person. A path that leaves
  the skill is a name nothing has. `run_skill_script` is never offered: no script runs.
- **Sources.** Bundled skills (`bundled`, in memory: build assets) come first; the person's own are kept in IndexedDB, one database
  per principal (`fadenstack-skills`, standalone as its own principal), and in memory where there is no IndexedDB. `skills.store` is
  a small API to add, list and remove a skill; a change is read at the start of the next turn. A skill's resources are text files by
  relative name; there is no folder in a browser.
- **Policy.** With a server, local skills are on only when the agent's profile says `local_skills.mode` is `allow` or the user's
  developer mode is on; absent or unknown is off. Standalone they are on unless the person or the machine policy turned them off. A
  machine policy that lists sources keeps only the bundled skills: a list names no folder in a browser.
- **The six fields.** A skill keeps `name` (lowercase letters, digits and single hyphens, up to 64), `description` (up to 1,024),
  `license`, `compatibility` (up to 500), `metadata` and `allowed-tools`, beside its body and resources. A skill with another field,
  or one that breaks a limit, is skipped and logged; the others stay.
- **`faden.yaml` pre-selection.** A skill's `faden.yaml` text (`fadenYaml`) is read once per refresh, by core's rules (`activation`,
  `priority`, `tags`, `trigger_rules.keywords` and `file_types`, `preferred_tools`), with the limits of core's `safe_yaml`: 32 KiB,
  8 levels, no anchors, aliases or tags. Each turn the model is told the skills its message matches (up to 3, named ones first) and
  the skills without triggers; a skill named with `$slug`, always on, or matched on a keyword gets its instructions loaded for the
  turn, marked as skill text. The preferred tools are a hint in that text. A skill without a `faden.yaml`, or with one that does not
  read (logged), is listed as before.
- **Skill text is untrusted.** It never changes a tool's class, a mode or a grant.
