# Skills

A skill is a set of instructions and reference files for one kind of task, in the open
[Agent Skills](https://agentskills.io) format: a `SKILL.md` with its frontmatter, plus optional files.
`@fadenstack/skills` gives an agent the person's own skills and the app's bundled ones. The model sees a short list. It
loads a skill's instructions when a task matches (`load_skill`) and reads a listed file when it needs one
(`read_skill_resource`). Scripts never run. The .NET SDK has the same module (`Fadenstack.Skills`), with MAF's skills
provider underneath. A browser has no MAF, so this package has a loader of its own with the same two tools and answers.

```ts
import { skillsModule } from "@fadenstack/skills";

const skills = skillsModule({
  bundled: [{ name: "slide-design", description: "Designs slides ...", body, fadenYaml }],  // build assets
  // the person's own skills: IndexedDB per principal by default (fadenstack-skills), memory where there is none
});
const agent = FadenstackAgent.createBuilder().useEndpoint(endpoint).useLocalProfile(definition).use(skills).build();
```

## The format

`SKILL.md` keeps only the six standard frontmatter fields:
- `name`: 1 to 64 lowercase letters, digits and single hyphens;
- `description`: up to 1,024 characters;
- optional: `license`, `compatibility` (up to 500 characters), `metadata`, `allowed-tools`.

A skill with another key is skipped and logged.

Fadenstack's own fields go in a `faden.yaml` beside it, as on the server:
- `title`, `tags`, `priority`, `activation`;
- `trigger_rules`: `keywords`, `file_types`, `intents`;
- `preferred_tools`.

It is read with a restricted reader (32 KiB, depth 8). It refuses anchors, aliases, tags, block scalars and invisible
characters. Quote `yes`, `no`, `on` and `off` in a keyword list: unquoted, they are booleans, as on the server, and the
file does not read.

## Which skills a turn gets

The server's rules apply:
- skills the person names with `$slug` first, up to 5;
- then `always` and matching `auto` skills by score, up to 3;
- a keyword (as a whole word) +30, a file type +30, a tag +20, on top of the priority;
- `manual` skills only by name.

The model sees the resolved list. The first strong match is put into the turn's instructions as skill text: a named
skill, an `always` skill, or a keyword or file-type hit. Only one is put in (`maxPreloaded`): the server puts in every
resolved skill, but a local model's context is short. `load_skill` still loads any skill.

## Where skills come from, and who decides

The skills come from three places:
- bundled with the app, read-only;
- the person's own, in IndexedDB per principal (deleted with `deleteMyData`, once no other app uses the person's data, or with `scope: "allApps"`), labelled "not reviewed";
  the module learns whose they are from the agent's profile (standalone: the standalone principal), whatever the policy says, so
  before the agent has started its list holds the bundled skills only and a change is refused
  (`SkillsPersonUnknownError`), as in the .NET SDK;
- the organisation's, with a server, read-only.

Which of them the agent may use:
- **With a server:** local skills only when the profile's `local_skills.mode` is `allow`, or `developer_mode` is on.
- **Without one:** on, unless the [machine policy](machine-policy.md)'s `skills` forbids them. A list of sources keeps
  only the bundled skills in a browser.
- **The person's switch:** each skill can be turned on or off, per principal.

## The editor

`@fadenstack/ui` has `SkillLibraryViewModel`, `SkillEditorViewModel` and `SkillDraftViewModel`. `@fadenstack/ui-react`
and `@fadenstack/ui-vue` draw them as `SkillLibrary`, `SkillEditor` and `SkillDraft`.

- **Import and export** go through a zip: a browser has no folders.
- **Test** shows, for a prompt, which skills the rules pick and pre-load.
- **"Draft from this chat"** proposes a skill from the conversation and opens it in the editor.

**Nothing is saved until the person presses Save.**

The editor's limits: the name up to 64 characters, the description up to 1,024, `compatibility` up to 500; a body over
about 5,000 tokens gets a warning, not a refusal; a file up to 1 MiB, all of a skill's files up to 5 MiB, at most 100
files; a zip up to 6 MiB, and one that expands to more than 100 times its size is refused.

## Drafting a skill

`SkillDraftViewModel` ("Draft from this chat") asks the chat's own model once for a `SKILL.md` and a `faden.yaml` that
fit the conversation, and opens the answer in the editor as a proposal.

- The model is shown the conversation, newest turns first, up to 24,000 characters; a single message is cut at 4,000.
- The model gets no tool. Its answer is read as text and held to the same rules as any skill, so a draft that breaks one
  opens in the editor with the problem shown.
- The draft has no way to save. Only the person's Save in the editor writes the skill. A model that could save skills
  could be talked into it by text in a document or a web page, and the skill would come back into every later chat.
- It says plainly when there is no chat to draw from (`NoChat`), no model (`NoModel`), or the answer could not be read.

## Security

- Skill text is information, never a rule: it never changes a tool's class, a tool mode or a grant. `preferred_tools`
  is a hint only.
- No scripts: `run_skill_script` is never offered; scripts and binary files are refused.
- A resource is read only by the name the skill lists, so no path leaves it.
- A single validator serves the editor, the import and the draft.
- The zip reader is strict:
  - it counts the bytes as they expand, whatever the archive claims;
  - it refuses traversal, absolute paths, backslashes, links, duplicate or overlapping entries, ZIP64, encryption and
    bombs;
  - it checks sizes, counts and CRCs.

  Nothing is stored before every check passes.

OWASP ASVS 5.0: V5 (file handling), V15 (secure coding).
